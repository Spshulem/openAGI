import Foundation

// Manages the lifecycle of the bundled Node daemon. Spawns once at app launch,
// passes data dir + port via env, captures stdout/stderr to a log file, kills
// it cleanly on quit.

final class DaemonController {
  static let shared = DaemonController()

  private var process: Process?
  private var logHandle: FileHandle?

  /// When restart() last ran — manual (tray) or automatic (AppState's
  /// /health-failure recovery). One shared clock, deliberately: the auto path
  /// throttles off this, so a restart the user just triggered holds it off for
  /// the same minute. With separate clocks the poller would SIGKILL the daemon
  /// the user started ~15s into its boot, then the user would press the button
  /// again, and the two would take turns killing each other.
  private(set) var lastRestartAt: Date = .distantPast

  private var bundleResources: URL {
    Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
  }

  private var nodeBinary: URL {
    bundleResources.appendingPathComponent("node/bin/node")
  }

  private var entrypoint: URL {
    bundleResources.appendingPathComponent("openAGI/examples/hosted-server.js")
  }

  private var dataDir: URL {
    AppState.dataDir()
  }

  private var logFile: URL {
    dataDir.appendingPathComponent("daemon.log")
  }

  func start() { start(adoptExisting: true) }

  /// `adoptExisting: false` is the "restart really means restart" path — see
  /// restart(force:). It skips the adopt branch below so the stale-port cleanup
  /// runs and we spawn a daemon we actually own a handle to.
  private func start(adoptExisting: Bool) {
    guard process == nil else { return }
    if !FileManager.default.fileExists(atPath: nodeBinary.path) {
      NSLog("OpenAGI: missing bundled Node binary at \(nodeBinary.path)")
      return
    }
    if !FileManager.default.fileExists(atPath: entrypoint.path) {
      NSLog("OpenAGI: missing JS entrypoint at \(entrypoint.path)")
      return
    }
    // If something is already listening on 43210 and answering /health like
    // OpenAGI, just adopt it instead of spawning a duplicate that will fail
    // with EADDRINUSE in a tight restart loop. Common when the user runs
    // `npm run serve` in a terminal alongside the .app.
    if adoptExisting, isExistingDaemonHealthy() {
      NSLog("OpenAGI: existing daemon detected on 127.0.0.1:43210; adopting it")
      return
    }

    // The health check just failed, but something may still be holding the
    // port (e.g. a previously-adopted daemon whose event loop hung, or one
    // pegged at 100% CPU no longer servicing requests). We have no Process
    // handle for it if we didn't spawn it ourselves, so `process` can't tell
    // us what to kill. Without this, every restart attempt spawns a new
    // child that immediately dies with EADDRINUSE and gets kept alive as a
    // zombie — auto-recovery loops forever without ever actually replacing
    // the stuck daemon.
    if let stalePid = Self.pidListeningOnPort(43210) {
      NSLog("OpenAGI: port 43210 held by unresponsive pid \(stalePid); killing it before respawn")
      kill(stalePid, SIGTERM)
      Thread.sleep(forTimeInterval: 1.0)
      if Self.pidListeningOnPort(43210) == stalePid {
        kill(stalePid, SIGKILL)
        Thread.sleep(forTimeInterval: 0.5)
      }
    }

    if !FileManager.default.fileExists(atPath: logFile.path) {
      FileManager.default.createFile(atPath: logFile.path, contents: nil)
    }
    logHandle = try? FileHandle(forWritingTo: logFile)
    logHandle?.seekToEndOfFile()

    let proc = Process()
    proc.executableURL = nodeBinary
    proc.arguments = [entrypoint.path]
    proc.currentDirectoryURL = dataDir

    var env = ProcessInfo.processInfo.environment
    env["OPENAGI_DATA_DIR"] = dataDir.path
    env["HOST"] = "127.0.0.1"
    env["PORT"] = "43210"
    proc.environment = env

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    proc.standardOutput = stdoutPipe
    proc.standardError = stderrPipe
    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if !d.isEmpty { self?.logHandle?.write(d) }
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if !d.isEmpty { self?.logHandle?.write(d) }
    }
    proc.terminationHandler = { [weak self] p in
      NSLog("OpenAGI: daemon exited with \(p.terminationStatus)")
      // Auto-restart on unexpected exit (e.g. crash) after a backoff.
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        if self?.process != nil { self?.process = nil; self?.start() }
      }
    }

    do {
      try proc.run()
      process = proc
      NSLog("OpenAGI: daemon started (pid \(proc.processIdentifier))")
    } catch {
      NSLog("OpenAGI: failed to launch daemon: \(error)")
    }
  }

  func stop() {
    guard let proc = process else { return }
    process = nil
    proc.terminationHandler = nil
    proc.terminate()
    // Give it a moment, then SIGKILL if still alive
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
      if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
    }
  }

  /// Bounce the daemon.
  ///
  /// `force: true` means "replace whatever is on 43210", and it is what the tray
  /// button and the health-poll recovery both want. Without it, restart is
  /// frequently a silent no-op: start() adopts an already-healthy daemon and
  /// returns without setting `process` (which happens on every relaunch while an
  /// older daemon is still alive — the user's is orphaned to PPID 1 right now),
  /// and with `process` nil, stop() short-circuits on its `guard let proc`. So
  /// restart degraded into a no-op stop plus a start() that re-adopted the very
  /// daemon it was asked to replace. That same nil handle is why Quit leaves the
  /// orphan behind, which is how the state perpetuates itself.
  ///
  /// Opt-in rather than the default because AppDelegate restarts on
  /// wake-from-sleep off a single 2s probe; a daemon merely slow to answer as
  /// the machine wakes should be adopted once it responds, not killed.
  func restart(force: Bool = false) {
    lastRestartAt = Date()
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start(adoptExisting: !force) }
  }

  /// Is anything LISTENING on the daemon port right now?
  ///
  /// Paired with a failing /health this is what separates the two failures that
  /// look identical from the outside: false means the process is gone, true
  /// means it is alive, still owns 43210, and has stopped answering — the state
  /// the user's daemon sat in for 25 hours (process state T, socket LISTENing).
  /// They need different words in the tray and different actions behind it.
  ///
  /// Hops off the main thread because pidListeningOnPort spawns lsof and blocks
  /// on it, and the only caller (AppState.pollOnce) is @MainActor.
  func isPortHeld() async -> Bool {
    await withCheckedContinuation { cont in
      // Static, so this @Sendable closure captures nothing but a port number —
      // DaemonController itself is not Sendable.
      DispatchQueue.global(qos: .utility).async {
        cont.resume(returning: Self.pidListeningOnPort(43210) != nil)
      }
    }
  }

  /// Async probe: is the daemon actually responding on /health right now?
  /// Returns false on connection refused, timeout, or any non-200.
  @MainActor
  func probeHealth() async -> Bool {
    guard let url = URL(string: "http://127.0.0.1:43210/health") else { return false }
    var req = URLRequest(url: url)
    req.timeoutInterval = 2.0
    do {
      let (_, resp) = try await URLSession.shared.data(for: req)
      if let http = resp as? HTTPURLResponse { return http.statusCode == 200 }
      return false
    } catch {
      return false
    }
  }

  /// POST /tick to the daemon. Used after wake-from-sleep so any cron jobs
  /// that were due during the sleep window run within ~1s instead of
  /// waiting up to OPENAGI_TICKER_MS for the resumed setInterval to fire.
  @MainActor
  func kickTick() async {
    guard let url = URL(string: "http://127.0.0.1:43210/tick") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = "{}".data(using: .utf8)
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    req.timeoutInterval = 3.0
    do {
      _ = try await URLSession.shared.data(for: req)
    } catch {
      NSLog("OpenAGI kickTick: \(error.localizedDescription)")
    }
  }

  /// Probe http://127.0.0.1:43210/health synchronously. Returns true only when
  /// it answers with `ok: true` so we don't shadow some unrelated service on
  /// the same port — we'd rather fail loudly than collide with it silently.
  private func isExistingDaemonHealthy() -> Bool {
    guard let url = URL(string: "http://127.0.0.1:43210/health") else { return false }
    let semaphore = DispatchSemaphore(value: 0)
    var found = false
    var req = URLRequest(url: url)
    req.timeoutInterval = 1.0
    let task = URLSession.shared.dataTask(with: req) { data, _, _ in
      defer { semaphore.signal() }
      guard let data = data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let ok = json["ok"] as? Bool, ok else { return }
      found = true
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 1.5)
    return found
  }

  /// PID of whatever process is currently LISTENING on the given TCP port,
  /// or nil if nothing is. Used to recover from a daemon that's still
  /// holding the port but no longer answering /health — see start().
  private static func pidListeningOnPort(_ port: UInt16) -> Int32? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    proc.arguments = ["-ti", "tcp:\(port)", "-sTCP:LISTEN"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = Pipe()
    do {
      try proc.run()
      proc.waitUntilExit()
    } catch {
      return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    let firstLine = text.split(separator: "\n").first.map(String.init) ?? text
    return Int32(firstLine)
  }
}
