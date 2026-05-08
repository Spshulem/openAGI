import Foundation

// Manages the lifecycle of the bundled Node daemon. Spawns once at app launch,
// passes data dir + port via env, captures stdout/stderr to a log file, kills
// it cleanly on quit.

final class DaemonController {
  static let shared = DaemonController()

  private var process: Process?
  private var logHandle: FileHandle?

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

  func start() {
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
    if isExistingDaemonHealthy() {
      NSLog("OpenAGI: existing daemon detected on 127.0.0.1:43210; adopting it")
      return
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

  func restart() {
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start() }
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
}
