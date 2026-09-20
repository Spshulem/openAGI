import Foundation

// `POST /message` with `Accept: text/event-stream` streams its reply
// directly on that same response -- a different mechanism from the
// always-on `GET /events` broadcast (src/hosted-interface.js's
// `streamLocalMessage`; its own comment is explicit that these delta frames
// "are not broadcast on /events"). mobile/PROTOCOL.md and mobile/FEATURES.md
// describe `POST /message` and `GET /events` as the two allowlisted routes
// without spelling out that the streamed reply rides on the POST itself;
// this client follows the daemon's actual source, not that ambiguity. See
// the phase report for the full note.
public struct ChatStatusFrame: Codable, Sendable, Equatable {
    public let stage: String
    public let sessionId: String?
}

public struct ChatSessionFrame: Codable, Sendable, Equatable {
    public let id: String
    public let messageCount: Int?
}

// `reset == true` means this delta starts a new tool hop and replaces
// whatever text had accumulated for the turn so far, rather than appending.
public struct ChatDeltaFrame: Codable, Sendable, Equatable {
    public let text: String
    public let reset: Bool
    public let sessionId: String?
}

public struct ChatFinalFrame: Codable, Sendable, Equatable {
    public let reply: String?
    public let session: ChatSessionFrame?
}

public struct ChatFailureFrame: Codable, Sendable, Equatable {
    public let code: String?
    public let error: String?
    public let sessionId: String?
}

public enum ChatEvent: Sendable, Equatable {
    case status(ChatStatusFrame)
    case session(ChatSessionFrame)
    case delta(ChatDeltaFrame)
    case final(ChatFinalFrame)
    case failure(ChatFailureFrame)

    // "heartbeat" (a keep-alive while a turn is outstanding) and anything
    // else this daemon might one day add both decode to nil: there is
    // nothing for the chat UI to do with them.
    public static func decode(_ event: SSEEvent) -> ChatEvent? {
        guard let data = event.data.data(using: .utf8) else { return nil }
        switch event.name {
        case "status":
            return (try? ProtocolDecoder.json.decode(ChatStatusFrame.self, from: data)).map(ChatEvent.status)
        case "session":
            return (try? ProtocolDecoder.json.decode(ChatSessionFrame.self, from: data)).map(ChatEvent.session)
        case "delta":
            return (try? ProtocolDecoder.json.decode(ChatDeltaFrame.self, from: data)).map(ChatEvent.delta)
        case "final":
            return (try? ProtocolDecoder.json.decode(ChatFinalFrame.self, from: data)).map(ChatEvent.final)
        case "failure":
            return (try? ProtocolDecoder.json.decode(ChatFailureFrame.self, from: data)).map(ChatEvent.failure)
        default:
            return nil
        }
    }
}
