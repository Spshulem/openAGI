import Foundation

// One line at a time in, a completed frame out. Deliberately free of
// URLSession entirely so the wire format (mobile/PROTOCOL.md §7:
// `event: <name>\ndata: <json>\n\n`, comment lines starting with `:`
// ignored) can be pinned against a fixed multi-line string in a unit test
// with no network, no daemon, and no async involved at all.
public struct SSEEvent: Sendable, Equatable {
    public let name: String
    public let data: String
}

public struct SSEFrameParser: Sendable {
    private var eventName: String?
    private var dataLines: [String] = []

    public init() {}

    // Feed one line (already stripped of its trailing newline, as
    // `URLSession.bytes(for:).lines` hands them). A blank line terminates
    // and emits the accumulated frame; anything else accumulates.
    public mutating func feed(_ line: String) -> SSEEvent? {
        if line.isEmpty {
            defer { eventName = nil; dataLines = [] }
            guard !dataLines.isEmpty else { return nil }
            return SSEEvent(name: eventName ?? "message", data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // comment / keep-alive ping -- never a frame
        guard let colon = line.firstIndex(of: ":") else {
            if line == "data" { dataLines.append("") }
            return nil
        }
        let field = String(line[line.startIndex..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "event": eventName = value
        case "data": dataLines.append(value)
        default: break // "id", "retry", anything else: not used by this daemon
        }
        return nil
    }
}

// The named events `GET /events` broadcasts, per mobile/PROTOCOL.md §7. The
// phone only needs to know *which* one fired to decide what to refresh and
// whether to bump the Inbox badge -- it re-fetches the affected surface
// rather than trying to apply a partial event payload locally.
public enum DaemonEvent: Sendable, Equatable {
    case hello
    case taskUpdated
    case taskReminder
    case taskAutoChanged
    case pendingAction
    case pendingActionResolved
    case clarificationCreated
    case unknown(name: String)

    public static func from(name: String) -> DaemonEvent {
        switch name {
        case "hello": return .hello
        case "task-updated": return .taskUpdated
        case "task-reminder": return .taskReminder
        case "task-auto-changed": return .taskAutoChanged
        case "pending-action": return .pendingAction
        case "pending-action-resolved": return .pendingActionResolved
        case "clarification-created": return .clarificationCreated
        default: return .unknown(name: name)
        }
    }
}
