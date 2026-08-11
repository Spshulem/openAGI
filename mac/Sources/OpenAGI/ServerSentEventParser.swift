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
}
