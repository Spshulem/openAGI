import Foundation

struct ChatMessage: Identifiable, Equatable, Sendable {
    enum Role: Equatable, Sendable { case user, assistant }
    let id: UUID
    var role: Role
    var text: String
    var isStreaming: Bool
    var isFailed: Bool
    var timestamp: Date
    // The daemon's id once this line is known to be stored in the shared
    // thread; nil while it exists only on this phone.
    var serverID: String?
    // Who sent a user line. Set only for lines read back from the daemon,
    // so the phone can say when a message came from another device.
    var sourceNodeId: String?
    var sourceName: String?

    init(id: UUID = UUID(), role: Role, text: String, isStreaming: Bool = false, isFailed: Bool = false,
         timestamp: Date = Date(), serverID: String? = nil, sourceNodeId: String? = nil, sourceName: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.isStreaming = isStreaming
        self.isFailed = isFailed
        self.timestamp = timestamp
        self.serverID = serverID
        self.sourceNodeId = sourceNodeId
        self.sourceName = sourceName
    }
}

// Converting between the bubble model and the saved file format.
enum ChatHistoryCodec {
    // What a reply that was still streaming becomes when it is saved: if the
    // app dies now, the next launch must not show a reply that will never
    // finish. Android says the same thing.
    static let stoppedText = "Reply stopped when the app closed."

    static func saved(_ message: ChatMessage) -> SavedChatEntry {
        let stopped = message.isStreaming && !message.isFailed
        return SavedChatEntry(
            id: message.id,
            serverID: message.serverID,
            role: message.role == .user ? "user" : "assistant",
            at: message.timestamp,
            text: stopped ? stoppedText : message.text,
            failed: message.isFailed || message.isStreaming,
            sourceNodeId: message.sourceNodeId,
            sourceName: message.sourceName
        )
    }

    static func message(_ entry: SavedChatEntry) -> ChatMessage {
        ChatMessage(
            id: entry.id,
            role: entry.role == "user" ? .user : .assistant,
            text: entry.text,
            isFailed: entry.failed,
            timestamp: entry.at,
            serverID: entry.serverID,
            sourceNodeId: entry.sourceNodeId,
            sourceName: entry.sourceName
        )
    }
}

// Folds one page of the daemon's shared thread (`GET /conversations/:thread/
// messages`, oldest first) into what the phone already shows. The daemon is
// the source of truth for everything inside the page's time window; the
// phone keeps only what the daemon cannot know about:
//
// - lines older than the page (the cache holds more history than one page),
// - a reply still streaming, and the user line that asked for it,
// - a failed send with its "Try again", unless the daemon has since stored
//   a reply to that same question (a reply that stopped when the app closed
//   but finished on main),
// - lines newer than anything on the page (sent here; not stored there yet).
//
// Identity is kept stable across merges -- a line already tied to a server
// id, or a local line matched to one by role and text, keeps its UUID -- so
// refreshing never rebuilds the list under the reader's thumb.
enum ChatHistoryMerge {
    // How far a phone's clock may run ahead of main's and still let a local
    // line match the daemon's copy of it.
    static let clockSlack: TimeInterval = 5 * 60

    static func merge(local: [ChatMessage], server: [ConversationMessage]) -> [ChatMessage] {
        guard let oldest = server.first?.at, let newest = server.last?.at else { return local }
        let serverIDs = Set(server.map(\.id))
        var serverIndexForID: [String: Int] = [:]
        for index in server.indices where serverIndexForID[server[index].id] == nil {
            serverIndexForID[server[index].id] = index
        }

        // Local lines already tied to a server id.
        var uuidForServerID: [String: UUID] = [:]
        for message in local {
            if let serverID = message.serverID, serverIDs.contains(serverID) {
                uuidForServerID[serverID] = message.id
            }
        }

        // Match local-only lines to unclaimed server lines by role and text.
        var claimed = Set(uuidForServerID.keys)
        var matchedServerIndex: [UUID: Int] = [:]
        for message in local where message.serverID == nil && !message.isStreaming && !message.isFailed {
            let text = normalized(message.text)
            guard let index = server.indices.first(where: { index in
                let candidate = server[index]
                return !claimed.contains(candidate.id)
                    && role(candidate.role) == message.role
                    && normalized(candidate.text) == text
                    && candidate.at >= message.timestamp.addingTimeInterval(-clockSlack)
            }) else { continue }
            claimed.insert(server[index].id)
            uuidForServerID[server[index].id] = message.id
            matchedServerIndex[message.id] = index
        }

        var result: [(message: ChatMessage, sortKey: Date)] = []

        // Older than the page: the daemon said nothing about these.
        for message in local where message.timestamp < oldest && !message.isStreaming && !message.isFailed {
            if let serverID = message.serverID, serverIDs.contains(serverID) { continue }
            if matchedServerIndex[message.id] != nil { continue }
            result.append((message, message.timestamp))
        }

        for item in server {
            let message = ChatMessage(
                id: uuidForServerID[item.id] ?? UUID(),
                role: role(item.role),
                text: item.text,
                timestamp: item.at,
                serverID: item.id,
                sourceNodeId: item.sourceNodeId,
                sourceName: item.sourceName
            )
            result.append((message, item.at))
        }

        // Inside or after the page's window, local-only lines survive only
        // when the daemon cannot know about them yet.
        // Streaming and failed lines are always decided here, whatever their
        // time: a failed reply's clock can read earlier than the page.
        for (position, message) in local.enumerated()
        where message.timestamp >= oldest || message.isStreaming || message.isFailed {
            if message.serverID != nil || matchedServerIndex[message.id] != nil { continue }
            // The user line this one answers, if it is on the daemon's page:
            // matched just now, or already server-backed (a refresh that
            // landed mid-stream tied it to its server id).
            let askedAt = precedingUserIndex(position, in: local).flatMap { index in
                local[index].serverID.flatMap { serverIndexForID[$0] } ?? matchedServerIndex[local[index].id]
            }
            if message.isStreaming {
                result.append((message, .distantFuture))
            } else if message.isFailed {
                if message.role == .assistant, let asked = askedAt, hasReply(after: asked, in: server) { continue }
                let anchor = askedAt.map { max(server[$0].at, message.timestamp) } ?? message.timestamp
                result.append((message, anchor))
            } else if message.role == .user, let next = local[safe: position + 1], next.role == .assistant,
                      next.isStreaming || next.isFailed, next.serverID == nil {
                // Asked, and its reply is still streaming or failed, and the
                // daemon has not stored the question: keep it beside its reply.
                result.append((message, next.isStreaming ? .distantFuture : message.timestamp))
            } else if message.timestamp > newest {
                result.append((message, message.timestamp))
            }
        }

        // Stable: equal keys keep insertion order (older, server, pending).
        return result.enumerated()
            .sorted { lhs, rhs in
                lhs.element.sortKey == rhs.element.sortKey ? lhs.offset < rhs.offset : lhs.element.sortKey < rhs.element.sortKey
            }
            .map(\.element.message)
    }

    private static func role(_ role: ConversationMessage.Role) -> ChatMessage.Role {
        role == .user ? .user : .assistant
    }

    private static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func precedingUserIndex(_ position: Int, in local: [ChatMessage]) -> Int? {
        guard position > 0 else { return nil }
        return local[..<position].lastIndex(where: { $0.role == .user })
    }

    // Whether the daemon stored an assistant line after the user line at
    // `index`, before the next user line.
    private static func hasReply(after index: Int, in server: [ConversationMessage]) -> Bool {
        for item in server[(index + 1)...] {
            if item.role == .user { return false }
            if item.role == .assistant { return true }
        }
        return false
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
