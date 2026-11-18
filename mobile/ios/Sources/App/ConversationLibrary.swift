import Foundation
import Observation
import CryptoKit

// The catalog and every draft belong to this pairing. The two original shared
// chats keep their existing files, so upgrading does not erase their history.
@MainActor @Observable
final class ConversationLibrary {
    private(set) var summaries: [ConversationSummary] = []
    private(set) var isLoading = false
    private(set) var isCreating = false
    private(set) var error: String?
    private var selectedIDs: [ConversationThread: String] = [:]
    private var chats: [String: ChatConversation]
    private let client: DaemonClient
    private let nodeID: String
    private let server: URL
    private let directory: URL
    private let catalogFile: URL
    private var active = true
    private var generation = 0

    init(client: DaemonClient, credentials: Credentials, directory: URL,
         agent: ChatConversation, supervisor: ChatConversation) {
        self.client = client
        self.nodeID = credentials.nodeID
        self.server = credentials.server
        self.directory = directory
        let scope = Self.digest(credentials.server.absoluteString + "|" + credentials.nodeID)
        self.catalogFile = directory.appending(path: "conversations-\(scope).json")
        self.chats = [agent.identity: agent, supervisor.identity: supervisor]
        if let data = try? Data(contentsOf: catalogFile),
           let catalog = try? ProtocolDecoder.json.decode(ConversationCatalog.self, from: data) {
            summaries = catalog.conversations
        }
    }

    func selected(_ thread: ConversationThread) -> ChatConversation {
        conversation(thread: thread, id: selectedIDs[thread] ?? "main")
    }

    func select(_ summary: ConversationSummary) {
        guard active else { return }
        selectedIDs[summary.thread] = summary.id
        _ = conversation(thread: summary.thread, id: summary.id)
    }

    func records(for thread: ConversationThread) -> [ConversationSummary] {
        summaries.filter { $0.thread == thread }
    }

    func refresh() async {
        guard active, !isLoading else { return }
        isLoading = true
        let issued = generation
        defer { isLoading = false }
        do {
            let result = try await client.conversations()
            guard active, issued == generation else { return }
            summaries = result
            error = nil
            save()
        } catch {
            guard active, issued == generation else { return }
            switch error as? DaemonError {
            case .notFound:
                self.error = "The server isn't allowing the conversation list. Check its OpenAGI version and phone access. Your saved chats and pairing are kept; no new code is needed."
            case .malformedResponse:
                self.error = "The server responded with unexpected conversation data. Update OpenAGI on the server, then retry. Your saved chats and pairing have been kept."
            default:
                self.error = "Couldn't refresh conversations. " + ServerConnectionGuidance.savedPairingFailure(error, server: server)
            }
        }
    }

    @discardableResult
    func create(thread: ConversationThread, sourceID: String? = nil) async -> Bool {
        guard active, !isCreating else { return false }
        isCreating = true
        generation += 1
        defer { isCreating = false }
        do {
            let summary = try await client.createConversation(thread: thread, sourceId: sourceID)
            guard active else { return false }
            summaries.removeAll { $0.key == summary.key }
            summaries.insert(summary, at: 0)
            select(summary)
            error = nil
            save()
            return true
        } catch {
            self.error = error as? DaemonError == .notFound
                ? "Update OpenAGI on your server before creating a new chat. Nothing was sent to another conversation."
                : "Couldn't create the chat. Check your connection and try again."
            return false
        }
    }

    func refreshOpenChats() async {
        let open = Array(chats.values)
        for chat in open { await chat.refresh() }
        await refresh()
    }

    func suspend() {
        active = false
        chats.values.forEach { $0.suspend() }
    }

    func forget() {
        active = false
        for summary in summaries where summary.id != "main" {
            historyStore(thread: summary.thread, id: summary.id).delete()
        }
        chats.values.forEach { $0.forget() }
        summaries = []
        try? FileManager.default.removeItem(at: catalogFile)
    }

    private func conversation(thread: ConversationThread, id: String) -> ChatConversation {
        let key = "\(thread.rawValue):\(id)"
        if let chat = chats[key] { return chat }
        let readOnly = summaries.first { $0.key == key }?.readOnly ?? false
        let chat = ChatConversation(thread: thread, client: client, store: historyStore(thread: thread, id: id),
                                    nodeID: nodeID, conversationID: id, isReadOnly: readOnly)
        chats[key] = chat
        return chat
    }

    private func historyStore(thread: ConversationThread, id: String) -> ChatHistoryStore {
        ChatHistoryStore(thread: "\(thread.rawValue)-\(Self.digest(catalogFile.lastPathComponent + id))", directory: directory)
    }

    private func save() {
        guard active, let data = try? ProtocolDecoder.jsonEncoder.encode(ConversationCatalog(conversations: summaries)) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: catalogFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
