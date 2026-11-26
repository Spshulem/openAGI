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

// One queued message main has not taken yet: typed while a reply ran and
// not yet uploaded to the hub's queue (offline, main restarting), or waiting
// in this phone's own queue on a main without one. Kept so a force-quit or a
// relaunch while offline never loses it; it keeps its turn id, so when it
// does go main runs it once. Keeps the full image data (the history file
// keeps only previews). Messages the hub accepted are not kept here: the
// hub's queue is durable and the tray mirrors it.
public struct SavedQueuedMessage: Codable, Sendable, Equatable {
    public var requestID: String
    public var text: String
    public var attachments: [ChatAttachment]
    public var focusedCardID: String?
    // For the hub's queue (true), or this phone's own queue (false).
    public var pendingUpload: Bool
    // An upload went out and no answer came back: the hub may have it.
    public var uploadAttempted: Bool
    // The hub's last refusal, shown on its row.
    public var error: String?
    // "Send anyway": when the hub takes it, it goes next and the running
    // reply is stopped. Optional, so files written before it decode.
    public var sendNext: Bool?

    public init(requestID: String, text: String, attachments: [ChatAttachment], focusedCardID: String?,
                pendingUpload: Bool, uploadAttempted: Bool, error: String? = nil, sendNext: Bool? = nil) {
        self.requestID = requestID
        self.text = text
        self.attachments = attachments
        self.focusedCardID = focusedCardID
        self.pendingUpload = pendingUpload
        self.uploadAttempted = uploadAttempted
        self.error = error
        self.sendNext = sendNext
    }
}

// The full images of a sent turn main has not confirmed yet, keyed by its
// user line (`SavedChatEntry.id`, which a retry keeps). The history keeps
// only previews, so without these a relaunch could not resend the turn.
public struct SavedSendingImages: Codable, Sendable, Equatable {
    public var userID: UUID
    public var attachments: [ChatAttachment]

    public init(userID: UUID, attachments: [ChatAttachment]) {
        self.userID = userID
        self.attachments = attachments
    }
}

private struct SavedQueue: Codable {
    var nodeID: String
    var items: [SavedQueuedMessage]
    // Optional, so files written before it decode.
    var sending: [SavedSendingImages]?
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
    // Queued messages main has not taken yet, beside the history and scoped
    // the same way. A separate file: the history is rewritten often and must
    // not carry image data.
    private let queueFile: URL

    public init(thread: String, directory: URL = ChatHistoryStore.defaultDirectory) {
        self.file = directory.appending(path: "chat-\(thread).json")
        self.queueFile = directory.appending(path: "chat-\(thread).queued.json")
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

    private func loadQueueFile(nodeID: String) -> SavedQueue? {
        guard let data = try? Data(contentsOf: queueFile),
              let saved = try? ProtocolDecoder.json.decode(SavedQueue.self, from: data),
              saved.nodeID == nodeID
        else { return nil }
        return saved
    }

    public func loadQueued(nodeID: String) -> [SavedQueuedMessage] {
        loadQueueFile(nodeID: nodeID)?.items ?? []
    }

    public func loadSending(nodeID: String) -> [SavedSendingImages] {
        loadQueueFile(nodeID: nodeID)?.sending ?? []
    }

    // Never trimmed: every item is something the person asked to send.
    // Nothing left, no file.
    public func saveQueued(nodeID: String, items: [SavedQueuedMessage], sending: [SavedSendingImages] = []) {
        guard !items.isEmpty || !sending.isEmpty else {
            try? FileManager.default.removeItem(at: queueFile)
            return
        }
        guard let data = try? ProtocolDecoder.jsonEncoder.encode(SavedQueue(nodeID: nodeID, items: items, sending: sending.isEmpty ? nil : sending)) else { return }
        try? FileManager.default.createDirectory(at: queueFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: queueFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func delete() {
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: queueFile)
    }
}
