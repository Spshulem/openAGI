import Foundation

// One saved chat line. Kept separate from the UI's `ChatMessage` so the file
// format does not change every time the bubble model does. `serverID` is the
// daemon's message id once the line is known to be stored there (from
// `GET /conversations/:thread/messages`); nil for a line only this phone has
// seen so far -- one still sending, or one that failed.
public struct SavedChatEntry: Codable, Sendable, Equatable {
    public var id: UUID
    public var serverID: String?
    public var role: String
    public var at: Date
    public var text: String
    public var retrySafe: Bool?
    public var failed: Bool
    public var sourceNodeId: String?
    public var sourceName: String?
    public var attachments: [ChatAttachment]?
    // Turn recovery (all optional: older caches decode unchanged). The
    // client's id for the turn; a reply main accepted whose stream was lost
    // (still being recovered); and a send never confirmed, to retry once.
    public var requestID: String?
    public var detached: Bool?
    public var autoRetry: Bool?
    public var newRequestOnRetry: Bool?

    public init(id: UUID, serverID: String? = nil, role: String, at: Date, text: String, failed: Bool = false, retrySafe: Bool? = nil,
                sourceNodeId: String? = nil, sourceName: String? = nil, attachments: [ChatAttachment]? = nil,
                requestID: String? = nil, detached: Bool? = nil, autoRetry: Bool? = nil, newRequestOnRetry: Bool? = nil) {
        self.id = id
        self.serverID = serverID
        self.role = role
        self.at = at
        self.text = text
        self.failed = failed
        self.retrySafe = retrySafe
        self.sourceNodeId = sourceNodeId
        self.sourceName = sourceName
        self.attachments = attachments
        self.requestID = requestID
        self.detached = detached
        self.autoRetry = autoRetry
        self.newRequestOnRetry = newRequestOnRetry
    }
}

private struct SavedConversation: Codable {
    var nodeID: String
    var entries: [SavedChatEntry]
}

// One message in a conversation's outbox: written before anything goes to
// the network, so a force-quit, a crash or a dead connection never loses it
// and never sends it twice. Keeps the full image data (the history file
// keeps only previews) so it can still be sent after a relaunch.
public struct SavedOutboxItem: Codable, Sendable, Equatable {
    public var id: UUID
    public var requestID: String
    public var text: String
    public var attachments: [ChatAttachment]
    public var focusedCardID: String?
    public var createdAt: Date
    // "queued", "sending", "notSent" or "failed". A string, so a state this
    // build does not know reads as "failed" (needs the person), not lost.
    public var state: String
    // A POST with this id may have reached main.
    public var maybeDelivered: Bool
    public var failureText: String?
    public var retryNeedsNewID: Bool?
    public var shownQueued: Bool?

    public init(id: UUID, requestID: String, text: String, attachments: [ChatAttachment], focusedCardID: String?,
                createdAt: Date, state: String, maybeDelivered: Bool, failureText: String? = nil,
                retryNeedsNewID: Bool? = nil, shownQueued: Bool? = nil) {
        self.id = id
        self.requestID = requestID
        self.text = text
        self.attachments = attachments
        self.focusedCardID = focusedCardID
        self.createdAt = createdAt
        self.state = state
        self.maybeDelivered = maybeDelivered
        self.failureText = failureText
        self.retryNeedsNewID = retryNeedsNewID
        self.shownQueued = shownQueued
    }
}

private struct SavedOutbox: Codable {
    var nodeID: String
    var items: [SavedOutboxItem]
}

// A conversation kept on the phone so a relaunch, a process kill, or a
// daemon that is unreachable right now does not wipe it -- the same job as
// Android's ChatHistoryStore. The daemon's shared thread is the source of
// truth; this is the offline cache and the home of lines the daemon has not
// stored (an in-flight send, a failure). One file per thread, bound to the
// pairing that wrote it: a file from another node id reads as empty, so
// re-pairing to a different daemon never shows the old one's conversation.
// Only the newest `maxEntries` lines are kept.
public struct ChatHistoryStore: Sendable {
    public static let maxEntries = 200

    private let file: URL
    // The outbox sits beside the history, scoped the same way. A separate
    // file: the history is rewritten often and must not carry image data.
    private let outboxFile: URL

    public init(thread: String, directory: URL = ChatHistoryStore.defaultDirectory) {
        self.file = directory.appending(path: "chat-\(thread).json")
        self.outboxFile = directory.appending(path: "chat-\(thread).outbox.json")
    }

    // Application Support, not the App Group container: the widget never
    // reads chat, so there is no reason to widen who can see it.
    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(filePath: NSTemporaryDirectory())
        let directory = base.appending(path: "chat-history")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    public func load(nodeID: String) -> [SavedChatEntry] {
        guard let data = try? Data(contentsOf: file),
              let saved = try? ProtocolDecoder.json.decode(SavedConversation.self, from: data),
              saved.nodeID == nodeID
        else { return [] } // A torn or old-format file costs the history, never the app.
        return saved.entries
    }

    // Best-effort: a full disk loses the newest lines, not the chat.
    public func save(nodeID: String, entries: [SavedChatEntry]) {
        let kept = Array(entries.suffix(Self.maxEntries))
        guard let data = try? ProtocolDecoder.jsonEncoder.encode(SavedConversation(nodeID: nodeID, entries: kept)) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func loadOutbox(nodeID: String) -> [SavedOutboxItem] {
        guard let data = try? Data(contentsOf: outboxFile),
              let saved = try? ProtocolDecoder.json.decode(SavedOutbox.self, from: data),
              saved.nodeID == nodeID
        else { return [] }
        return saved.items
    }

    // Never trimmed: every item is something the person asked to send.
    public func saveOutbox(nodeID: String, items: [SavedOutboxItem]) {
        guard !items.isEmpty else {
            try? FileManager.default.removeItem(at: outboxFile)
            return
        }
        guard let data = try? ProtocolDecoder.jsonEncoder.encode(SavedOutbox(nodeID: nodeID, items: items)) else { return }
        try? FileManager.default.createDirectory(at: outboxFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: outboxFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func delete() {
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: outboxFile)
    }
}
