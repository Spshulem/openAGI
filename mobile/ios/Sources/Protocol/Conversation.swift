import Foundation

// The two shared conversations every paired device (phones and G2) talks
// into: one fixed daemon session per thread for this owner, so a question
// asked on the glasses shows up in the phone's Chat and the other way round.
// `POST /message` carries `thread`, and `GET /conversations/:thread/messages`
// reads it back.
public enum ConversationThread: String, Codable, Sendable, CaseIterable {
    case agent
    case supervisor
}

// One stored turn, user or assistant text only -- the daemon never sends
// tool calls on this route. `sourceName` is the device that sent a user turn
// ("Spencer's G2"), so the phone can say where a message came from when it
// was not this phone.
public struct ConversationMessage: Codable, Sendable, Equatable, Identifiable {
    public enum Role: String, Codable, Sendable {
        case user, assistant
    }

    public let id: String
    public let role: Role
    public let text: String
    public let at: Date
    public let sourceNodeId: String?
    public let sourceName: String?

    public init(id: String, role: Role, text: String, at: Date, sourceNodeId: String? = nil, sourceName: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.sourceNodeId = sourceNodeId
        self.sourceName = sourceName
    }
}

// `GET /conversations/:thread/messages` -- oldest first, with `nextBefore`
// naming the id to page back from (nil once the start is reached). A message
// with an unknown role or no id is dropped rather than failing the page: one
// odd record must not blank the whole conversation.
public struct ConversationPage: Decodable, Sendable, Equatable {
    public let thread: String?
    public let messages: [ConversationMessage]
    public let nextBefore: String?

    public init(thread: String?, messages: [ConversationMessage], nextBefore: String?) {
        self.thread = thread
        self.messages = messages
        self.nextBefore = nextBefore
    }

    private enum CodingKeys: String, CodingKey { case thread, messages, nextBefore }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try? container.decodeIfPresent(String.self, forKey: .thread)
        nextBefore = try? container.decodeIfPresent(String.self, forKey: .nextBefore)
        let raw = (try? container.decodeIfPresent([Lenient<ConversationMessage>].self, forKey: .messages)) ?? []
        messages = raw.compactMap(\.value)
    }
}

// Decodes one array element, or nil when that element is malformed, so a
// list can drop a bad entry instead of throwing for the whole payload.
public struct Lenient<T: Decodable & Sendable>: Decodable, Sendable {
    public let value: T?

    public init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}
