import Foundation

// Pushes locally-stored observations to the daemon's POST /observations
// endpoint in batches. Local SQLite is the source of truth; we mark rows
// as `pushed=1` only after the daemon confirms receipt.

final class CaptureBridge {
  static let shared = CaptureBridge()

  private var timer: Timer?
  private var pushing = false

  func start() {
    stop()
    timer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
      Task { await self?.flushOnce() }
    }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }

  func flushOnce() async {
    if pushing { return }
    pushing = true
    defer { pushing = false }

    let batch = CaptureStorage.shared.unpushedBatch(limit: 100)
    if batch.isEmpty { return }

    // TODO(roadmap/remote-capture): make this configurable so the Mac
    // can run as a capture-only client streaming to a remote daemon
    // (e.g. a home Mac mini). Plumbing to a remote URL + bearer token
    // is the same as localhost; just a settings field + UserDefaults.
    // See docs/ROADMAP.md for the full design.
    let url = URL(string: "http://127.0.0.1:43210/observations")!
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = await tokenSafe() {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let payload = batch.map { row -> [String: Any] in
      var copy = row
      copy.removeValue(forKey: "_id")
      copy.removeValue(forKey: "_table")
      return copy
    }
    let envelope: [String: Any] = ["observations": payload]
    do {
      req.httpBody = try JSONSerialization.data(withJSONObject: envelope)
    } catch {
      NSLog("OpenAGI bridge: failed to serialize batch: \(error)")
      return
    }

    do {
      let (_, response) = try await URLSession.shared.data(for: req)
      guard let http = response as? HTTPURLResponse, http.statusCode < 400 else {
        NSLog("OpenAGI bridge: daemon rejected batch (\((response as? HTTPURLResponse)?.statusCode ?? -1))")
        return
      }
      // Mark pushed
      var aIds: [Int64] = []
      var fIds: [Int64] = []
      for row in batch {
        guard let id = row["_id"] as? Int64, let table = row["_table"] as? String else { continue }
        if table == "activity" { aIds.append(id) }
        else if table == "frames" { fIds.append(id) }
      }
      CaptureStorage.shared.markPushed(activityIds: aIds, frameIds: fIds)
    } catch {
      NSLog("OpenAGI bridge: \(error.localizedDescription)")
    }
  }

  @MainActor
  private func tokenSafe() async -> String? {
    AppState.shared.authToken()
  }

  // Convenience: nudge the bridge to flush immediately (e.g. on app quit).
  static func flushNow() async {
    await CaptureBridge.shared.flushOnce()
  }
}
