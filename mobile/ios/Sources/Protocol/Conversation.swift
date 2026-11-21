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

public struct ConversationSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let thread: ConversationThread
    public let title: String
    public let preview: String
    public let updatedAt: Date
    public let messageCount: Int
    public let readOnly: Bool
    public var key: String { "\(thread.rawValue):\(id)" }
}

public struct ConversationCatalog: Codable, Sendable {
    public let conversations: [ConversationSummary]
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
    public let attachments: [ChatAttachment]?
    // The turn this line belongs to (mobile/PROTOCOL.md §3.1, "Recovering a
    // turn"): a phone matches its own send and the reply to it by this.
    public let requestId: String?
    // "failed" on the record main stores when a turn could not finish.
    public let status: String?

    public init(id: String, role: Role, text: String, at: Date, sourceNodeId: String? = nil, sourceName: String? = nil,
                attachments: [ChatAttachment]? = nil, requestId: String? = nil, status: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.sourceNodeId = sourceNodeId
        self.sourceName = sourceName
        self.attachments = attachments
        self.requestId = requestId
        self.status = status
    }
}

// A turn main is still running in this thread with no client attached.
public struct InFlightTurn: Codable, Sendable, Equatable {
    public let requestId: String
    public let stage: String?
    public let startedAt: Date?

    public init(requestId: String, stage: String? = nil, startedAt: Date? = nil) {
        self.requestId = requestId
        self.stage = stage
        self.startedAt = startedAt
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
    // Turns still running (newest page only). nil from a main older than
    // turn recovery, which cannot say: the phone then waits for the reply.
    public let inFlight: [InFlightTurn]?

    public init(thread: String?, messages: [ConversationMessage], nextBefore: String?, inFlight: [InFlightTurn]? = nil) {
        self.thread = thread
        self.messages = messages
        self.nextBefore = nextBefore
        self.inFlight = inFlight
    }

    private enum CodingKeys: String, CodingKey { case thread, messages, nextBefore, inFlight }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try? container.decodeIfPresent(String.self, forKey: .thread)
        nextBefore = try? container.decodeIfPresent(String.self, forKey: .nextBefore)
        let raw = (try? container.decodeIfPresent([Lenient<ConversationMessage>].self, forKey: .messages)) ?? []
        messages = raw.compactMap(\.value)
        inFlight = (try? container.decodeIfPresent([Lenient<InFlightTurn>].self, forKey: .inFlight))?.compactMap(\.value)
    }
}

// `GET /conversations/:thread/turns?ids=…` -- what main knows about turns
// this phone named. A state this build does not know decodes as nil (the
// entry is dropped): the phone then waits rather than resending.
public struct ConversationTurnStatus: Decodable, Sendable, Equatable {
    public enum State: String, Decodable, Sendable {
        // Accepted, waiting behind another turn in this conversation.
        case queued
        case running
        // Finished; the reply (or failure record) is in history.
        case done
        case failed
        // Main restarted while it ran: a retry is a new turn with a new id.
        case interrupted
        // Main never accepted it (or restarted first): resend, same id.
        case unknown
    }

    public let requestId: String
    public let state: State
    public let code: String?

    public init(requestId: String, state: State, code: String? = nil) {
        self.requestId = requestId
        self.state = state
        self.code = code
    }
}

public struct ConversationTurns: Decodable, Sendable, Equatable {
    public let thread: String?
    public let conversationId: String?
    public let active: [InFlightTurn]
    public let turns: [ConversationTurnStatus]

    public init(thread: String? = nil, conversationId: String? = nil, active: [InFlightTurn] = [], turns: [ConversationTurnStatus]) {
        self.thread = thread
        self.conversationId = conversationId
        self.active = active
        self.turns = turns
    }

    private enum CodingKeys: String, CodingKey { case thread, conversationId, active, turns }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try? container.decodeIfPresent(String.self, forKey: .thread)
        conversationId = try? container.decodeIfPresent(String.self, forKey: .conversationId)
        let rawActive = (try? container.decodeIfPresent([Lenient<InFlightTurn>].self, forKey: .active)) ?? []
        active = rawActive.compactMap(\.value)
        // Required: a body without `turns` is not this route's answer.
        turns = try container.decode([Lenient<ConversationTurnStatus>].self, forKey: .turns).compactMap(\.value)
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
