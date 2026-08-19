import Foundation
import Darwin

// Manages the lifecycle of the bundled Node daemon. Spawns once at app launch,
// passes data dir + port via env, captures stdout/stderr to a log file, kills
// it cleanly on quit.

final class DaemonController {
  static let shared = DaemonController()

  enum ListenerOwnership: Sendable {
    case none
    case managed
    case external
  }

  private var process: Process?
  private var logHandle: FileHandle?

  /// When restart() was last requested — manual (tray) or automatic (AppState's
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
    // OpenAGI, adopt it only when it is a separately-launched daemon (most
    // commonly `npm run serve`). A daemon running this app bundle's own Node
    // binary belongs to the app: replace it on launch so a Sparkle relaunch
    // cannot leave the previous bundle's JavaScript alive behind the new UI.
    //
    // If PID/executable discovery fails, preserve the process. Killing a
    // healthy listener is safe only after positively identifying it as ours.
    if adoptExisting, isExistingDaemonHealthy() {
      if let listenerPid = Self.pidListeningOnPort(43210),
         Self.isBundledDaemon(listenerPid, currentNodeBinary: nodeBinary) {
        NSLog("OpenAGI: bundled daemon pid \(listenerPid) survived app relaunch; replacing it")
      } else {
        NSLog("OpenAGI: healthy external daemon detected on 127.0.0.1:43210; adopting it")
        return
      }
    }

    // The health check either failed or positively identified a healthy
    // bundle-owned daemon left over from the previous app process. In both
    // cases something may still hold the port, and we have no Process handle
    // for it. Without this cleanup, respawn immediately dies with EADDRINUSE
    // and auto-recovery loops forever without replacing the stale runtime.
    if let stalePid = Self.pidListeningOnPort(43210) {
      guard ownsDaemon(listenerPid: stalePid) else {
        NSLog("OpenAGI: port 43210 is owned by external pid \(stalePid); refusing to terminate it")
        return
      }
      NSLog("OpenAGI: port 43210 held by pid \(stalePid); terminating it before respawn")
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
    env["OPENAGI_COMPUTER_HELPER"] = bundleResources.appendingPathComponent("OpenAGIComputerHelper").path
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
      DispatchQueue.main.async {
        guard let self, self.process === p else { return }
        // Release only the handle for the process that actually exited. A
        // manual restart during this crash backoff may already own a new,
        // healthy child; a stale termination callback must never clear it.
        self.process = nil
        // Auto-restart an unexpected exit (e.g. crash) after a backoff, but
        // yield to any manual or health-poll restart that starts first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
          guard let self, self.process == nil else { return }
          self.start()
        }
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

  /// AppKit does not keep the process alive for asynchronous termination
  /// cleanup. Quit therefore uses a short synchronous grace period and a
  /// final signal while this parent still exists; restart paths keep using the
  /// non-blocking stop() above so ordinary UI work never stalls.
  func stopForApplicationTermination() {
    guard let proc = process else { return }
    process = nil
    proc.terminationHandler = nil
    proc.terminate()
    let gracefulDeadline = Date().addingTimeInterval(0.75)
    while proc.isRunning && Date() < gracefulDeadline {
      Thread.sleep(forTimeInterval: 0.025)
    }
    if proc.isRunning {
      kill(proc.processIdentifier, SIGKILL)
      let killDeadline = Date().addingTimeInterval(0.25)
      while proc.isRunning && Date() < killDeadline {
        Thread.sleep(forTimeInterval: 0.01)
      }
    }
  }

  /// Bounce the daemon.
  ///
  /// `force: true` means "replace an app-owned listener instead of adopting
  /// it", and it is what the tray button and health-poll recovery both want.
  /// External listeners are always preserved. Without the flag, restart is
  /// frequently a silent no-op: start() adopts an already-healthy daemon and
  /// returns without setting `process` (which happens on every relaunch while an
  /// older bundle-owned daemon is still alive and reparented to launchd),
  /// and with `process` nil, stop() short-circuits on its `guard let proc`. So
  /// restart degraded into a no-op stop plus a start() that re-adopted the very
  /// daemon it was asked to replace. That same nil handle is why Quit leaves the
  /// orphan behind, which is how the state perpetuates itself.
  ///
  /// Opt-in rather than the default because AppDelegate restarts on
  /// wake-from-sleep off a single 2s probe; a daemon merely slow to answer as
  /// the machine wakes should be adopted once it responds, not killed.
  @discardableResult
  func restart(force: Bool = false) -> Bool {
    // Stamp attempts too, so automatic recovery does not hammer an external
    // listener every five seconds after a safe refusal.
    lastRestartAt = Date()
    // A manual/forced restart may replace an app-bundled daemon that survived
    // a relaunch, but it must never kill a terminal-managed server or an
    // unrelated process that happens to own the product port. start() repeats
    // this ownership check after the one-second delay to close the bind race.
    if force, let listenerPid = Self.pidListeningOnPort(43210),
       !ownsDaemon(listenerPid: listenerPid) {
      NSLog("OpenAGI: restart refused — port 43210 is managed by external pid \(listenerPid)")
      return false
    }
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start(adoptExisting: !force) }
    return true
  }

  private func ownsDaemon(listenerPid: Int32) -> Bool {
    if process?.processIdentifier == listenerPid { return true }
    return Self.isBundledDaemon(listenerPid, currentNodeBinary: nodeBinary)
  }

  /// Classify the current listener for the tray and health poll without ever
  /// launching `lsof` on the main actor. The result is display state only:
  /// restart(force:) repeats the ownership check immediately before signaling
  /// a process, so a listener change between poll and click remains safe.
  func listenerOwnership() async -> ListenerOwnership {
    let currentNodeBinary = nodeBinary
    return await withCheckedContinuation { cont in
      DispatchQueue.global(qos: .utility).async {
        guard let listenerPid = Self.pidListeningOnPort(43210) else {
          cont.resume(returning: .none)
          return
        }
        let ownership: ListenerOwnership = Self.isBundledDaemon(
          listenerPid,
          currentNodeBinary: currentNodeBinary
        ) ? .managed : .external
        cont.resume(returning: ownership)
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

  /// Resolve the executable behind a listener without trusting its command
  /// line (which a process controls). `proc_pidpath` asks the kernel for the
  /// executable vnode path and does not mutate or signal the process.
  private static func executablePath(for pid: Int32) -> String? {
    // PROC_PIDPATHINFO_MAXSIZE is a C expression macro (4 * MAXPATHLEN) and
    // therefore is not imported by Swift; spell out the same SDK contract.
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = buffer.withUnsafeMutableBufferPointer { pointer in
      proc_pidpath(pid, pointer.baseAddress, UInt32(pointer.count))
    }
    guard length > 0 else { return nil }
    return canonicalPath(URL(fileURLWithPath: String(cString: buffer)))
  }

  /// Sparkle atomically moves the old app into its installation cache before
  /// relaunching the new one. A Node process from that old bundle keeps its
  /// executable vnode open, but `proc_pidpath` can then return ENOENT. `lsof`
  /// still exposes the kernel-backed text vnode path, so accept only Sparkle's
  /// bundle-specific cache shape as the legacy fallback. A Homebrew/npm Node
  /// daemon cannot match either branch and remains adopted.
  private static func isBundledDaemon(_ pid: Int32, currentNodeBinary: URL) -> Bool {
    if executablePath(for: pid) == canonicalPath(currentNodeBinary) { return true }
    guard let movedExecutable = textExecutablePath(for: pid) else { return false }
    let cacheRoot = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Caches/app.openagi.daemon/org.sparkle-project.Sparkle/Installation", isDirectory: true)
      .standardizedFileURL.path + "/"
    return movedExecutable.hasPrefix(cacheRoot)
      && movedExecutable.hasSuffix("/OpenAGI.app/Contents/Resources/node/bin/node")
  }

  private static func textExecutablePath(for pid: Int32) -> String? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    proc.arguments = ["-a", "-p", String(pid), "-d", "txt", "-Fn"]
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
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    return text.split(separator: "\n")
      .lazy
      .filter { $0.first == "n" }
      .map { String($0.dropFirst()) }
      .first { $0.hasSuffix("/node/bin/node") }
  }

  private static func canonicalPath(_ url: URL) -> String {
    url.standardizedFileURL.resolvingSymlinksInPath().path
  }
}
