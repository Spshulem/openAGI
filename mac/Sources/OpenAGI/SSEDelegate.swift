import Foundation

// Listens to /events SSE and routes named events back to AppState for
// notifications + UI refresh. Auto-reconnects on disconnect.

final class SSEDelegate: NSObject, URLSessionDataDelegate {
  static let shared = SSEDelegate()

  private var buffer = ""

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let chunk = String(data: data, encoding: .utf8) else { return }
    buffer += chunk
    while let nl = buffer.range(of: "\n\n") {
      let block = String(buffer[..<nl.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<nl.upperBound)
      parseAndEmit(block)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // Reconnect after a backoff. The poller catches up state in the meantime.
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      AppState.shared.startSSE()
    }
  }

  private func parseAndEmit(_ block: String) {
    var event = "message"
    var data = ""
    for raw in block.split(separator: "\n") {
      let line = String(raw)
      if line.hasPrefix("event:") {
        event = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
      } else if line.hasPrefix("data:") {
        data += line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
      }
    }
    if !data.isEmpty {
      Task { @MainActor in AppState.shared.handleSSEEvent(event, data) }
    }
  }
}
