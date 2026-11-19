import Foundation

/// Minimal line-oriented SSE parser shared by long-running local requests.
/// URLSession.AsyncBytes.lines removes newline delimiters, so a blank line is
/// the frame boundary. Multiple data fields are joined exactly as the SSE
/// specification requires; comments and unknown fields are ignored.
struct ServerSentEvent: Equatable {
  let name: String
  let data: String
}

struct ServerSentEventParser {
  private var name = "message"
  private var dataLines: [String] = []

  mutating func consume(line: String) -> ServerSentEvent? {
    if line.isEmpty {
      guard !dataLines.isEmpty else {
        name = "message"
        return nil
      }
      let event = ServerSentEvent(name: name, data: dataLines.joined(separator: "\n"))
      name = "message"
      dataLines.removeAll(keepingCapacity: true)
      return event
    }
    if line.hasPrefix(":") { return nil }
    let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    let field = String(parts[0])
    var value = parts.count > 1 ? String(parts[1]) : ""
    if value.hasPrefix(" ") { value.removeFirst() }
    if field == "event" { name = value.isEmpty ? "message" : value }
    if field == "data" { dataLines.append(value) }
    return nil
  }

  /// Flushes any trailing buffered event lines if the SSE stream closed without a trailing blank line.
  mutating func finish() -> ServerSentEvent? {
    consume(line: "")
  }

  /// Splits raw bytes on `0x0A` while preserving empty lines (`""`) that mark SSE `\n\n` boundaries.
  /// (`URLSession.AsyncBytes.lines` skips zero-length lines and silently drops SSE frame delimiters.)
  static func lines(of bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          var buffer = Data()
          for try await byte in bytes {
            if byte == 0x0A {
              if buffer.last == 0x0D { buffer.removeLast() }
              let line = String(decoding: buffer, as: UTF8.self)
              buffer.removeAll(keepingCapacity: true)
              continuation.yield(line)
            } else {
              buffer.append(byte)
            }
          }
          if !buffer.isEmpty {
            if buffer.last == 0x0D { buffer.removeLast() }
            continuation.yield(String(decoding: buffer, as: UTF8.self))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
