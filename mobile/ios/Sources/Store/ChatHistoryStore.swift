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
    public var failed: Bool
    public var sourceNodeId: String?
    public var sourceName: String?

    public init(id: UUID, serverID: String? = nil, role: String, at: Date, text: String, failed: Bool = false,
                sourceNodeId: String? = nil, sourceName: String? = nil) {
        self.id = id
        self.serverID = serverID
        self.role = role
        self.at = at
        self.text = text
        self.failed = failed
        self.sourceNodeId = sourceNodeId
        self.sourceName = sourceName
    }
}

private struct SavedConversation: Codable {
    var nodeID: String
    var entries: [SavedChatEntry]
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

    public init(thread: String, directory: URL = ChatHistoryStore.defaultDirectory) {
        self.file = directory.appending(path: "chat-\(thread).json")
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

    public func delete() {
        try? FileManager.default.removeItem(at: file)
    }
}
