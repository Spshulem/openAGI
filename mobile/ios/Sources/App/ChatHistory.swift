import Foundation

struct ChatMessage: Identifiable, Equatable, Sendable {
    enum Role: Equatable, Sendable { case user, assistant }
    let id: UUID
    var role: Role
    var text: String
    var isStreaming: Bool
    var isFailed: Bool
    var retrySafe: Bool = true
    var timestamp: Date
    // The daemon's id once this line is known to be stored in the shared
    // thread; nil while it exists only on this phone.
    var serverID: String?
    // Who sent a user line. Set only for lines read back from the daemon,
    // so the phone can say when a message came from another device.
    var sourceNodeId: String?
    var sourceName: String?
    var attachments: [ChatAttachment]
    // What the agent is doing while this reply streams ("Using fleet
    // status"). Never saved: it means nothing once the reply is done.
    var activity: String?
    // Turn recovery (mobile/PROTOCOL.md §3.1). The client's id for the turn,
    // on the user line and on the reply placeholder.
    var requestID: String?
    // Main accepted this turn (its `session` frame arrived).
    var accepted = false
    // Accepted, then the stream was lost: main is still working. The reply
    // keeps streaming state and is found again in history, never resent.
    var isDetached = false
    // Not confirmed by main before the connection went: resend once (same
    // id, so main never runs it twice) when the app is next active.
    var autoRetry = false
    // Main lost this turn before it finished (restart): a retry is a new turn.
    var newRequestOnRetry = false

    init(id: UUID = UUID(), role: Role, text: String, isStreaming: Bool = false, isFailed: Bool = false,
         timestamp: Date = Date(), serverID: String? = nil, sourceNodeId: String? = nil, sourceName: String? = nil, attachments: [ChatAttachment] = []) {
        self.id = id
        self.role = role
        self.text = text
        self.isStreaming = isStreaming
        self.isFailed = isFailed
        self.timestamp = timestamp
        self.serverID = serverID
        self.sourceNodeId = sourceNodeId
        self.sourceName = sourceName
        self.attachments = attachments
    }
}

// Converting between the bubble model and the saved file format.
enum ChatHistoryCodec {
    // What a reply that was still streaming becomes when it is saved: if the
    // app dies now, the next launch must not show a reply that will never
    // finish. Android says the same thing.
    static let stoppedText = "Reply stopped when the app closed."
    static let stillWorking = "Still working…"
    static let unconfirmedText = "Not sent: the connection dropped before OpenAGI confirmed it."

    static func saved(_ message: ChatMessage) -> SavedChatEntry {
        // A reply main has accepted is still coming: keep recovering it after
        // a relaunch instead of calling it stopped.
        if message.isStreaming, message.requestID != nil, message.accepted || message.isDetached {
            return SavedChatEntry(id: message.id, serverID: message.serverID, role: "assistant", at: message.timestamp,
                                  text: "", failed: false, retrySafe: false, requestID: message.requestID, detached: true)
        }
        // A send main never confirmed: offer it again, and retry it once.
        if message.isStreaming, message.requestID != nil, !message.accepted {
            return SavedChatEntry(id: message.id, serverID: message.serverID, role: "assistant", at: message.timestamp,
                                  text: unconfirmedText, failed: true, retrySafe: true, requestID: message.requestID, autoRetry: true)
        }
        let stopped = message.isStreaming && !message.isFailed
        return SavedChatEntry(
            id: message.id,
            serverID: message.serverID,
            role: message.role == .user ? "user" : "assistant",
            at: message.timestamp,
            text: stopped ? stoppedText : message.text,
            failed: message.isFailed || message.isStreaming,
            retrySafe: !message.isStreaming && message.retrySafe && message.attachments.isEmpty,
            sourceNodeId: message.sourceNodeId,
            sourceName: message.sourceName,
            attachments: message.attachments.isEmpty ? nil : message.attachments.map(\.previewOnly),
            requestID: message.requestID,
            autoRetry: message.autoRetry ? true : nil,
            newRequestOnRetry: message.newRequestOnRetry ? true : nil
        )
    }

    static func message(_ entry: SavedChatEntry) -> ChatMessage {
        var message = ChatMessage(
            id: entry.id,
            role: entry.role == "user" ? .user : .assistant,
            text: entry.text,
            isFailed: entry.failed,
            timestamp: entry.at,
            serverID: entry.serverID,
            sourceNodeId: entry.sourceNodeId,
            sourceName: entry.sourceName,
            attachments: entry.attachments ?? []
        )
        message.retrySafe = entry.retrySafe ?? !entry.failed
        message.requestID = entry.requestID
        message.autoRetry = entry.autoRetry ?? false
        message.newRequestOnRetry = entry.newRequestOnRetry ?? false
        if entry.detached == true, entry.requestID != nil {
            message.isStreaming = true
            message.isDetached = true
            message.accepted = true
            message.activity = stillWorking
        }
        return message
    }

    static func restored(_ entries: [SavedChatEntry]) -> [ChatMessage] {
        var messages = entries.map(message)
        for index in messages.indices where messages[index].role == .assistant && messages[index].isFailed && messages[index].retrySafe {
            guard let user = messages[..<index].last(where: { $0.role == .user }),
                  user.attachments.contains(where: { $0.data == nil }) else { continue }
            messages[index].retrySafe = false
            messages[index].text += "\n\nReattach the images to try again; saved previews can't be sent to the model."
        }
        return messages
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

    // An earlier page must not run through the latest-page reconciliation:
    // that would discard the newer server-backed messages already on screen.
    static func prependOlder(local: [ChatMessage], server: [ConversationMessage], before cursor: String) -> [ChatMessage] {
        var seen = Set(local.compactMap(\.serverID))
        var result = local
        for item in server {
            guard seen.insert(item.id).inserted else { continue }
            if let index = result.firstIndex(where: {
                $0.serverID == nil && !$0.isStreaming && !$0.isFailed
                    && $0.role == role(item.role) && normalized($0.text) == normalized(item.text)
                    && $0.attachments.map(\.id) == (item.attachments ?? []).map(\.id)
                    && abs(item.at.timeIntervalSince($0.timestamp)) <= clockSlack
            }) {
                result[index] = ChatMessage(id: result[index].id, role: role(item.role), text: item.text,
                                            timestamp: item.at, serverID: item.id,
                                            sourceNodeId: item.sourceNodeId, sourceName: item.sourceName, attachments: item.attachments ?? [])
                continue
            }
            // A saved cache can include messages older than this page, with
            // a gap between it and the latest page. Insert into that gap,
            // keeping every existing message (including pending replies).
            let boundary = result.firstIndex(where: { $0.serverID == cursor }) ?? result.endIndex
            let index = result[..<boundary].firstIndex(where: { $0.timestamp > item.at }) ?? boundary
            result.insert(ChatMessage(role: role(item.role), text: item.text, timestamp: item.at,
                                      serverID: item.id, sourceNodeId: item.sourceNodeId, sourceName: item.sourceName, attachments: item.attachments ?? []), at: index)
        }
        return result
    }

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
            // The turn's own id when both sides have it; otherwise role and text.
            let byID = message.requestID.flatMap { id in
                server.indices.first { index in
                    !claimed.contains(server[index].id) && role(server[index].role) == message.role
                        && server[index].requestId == id
                }
            }
            guard let index = byID ?? server.indices.first(where: { index in
                let candidate = server[index]
                return !claimed.contains(candidate.id)
                    && role(candidate.role) == message.role
                    && normalized(candidate.text) == text
                    && message.attachments.map(\.id) == (candidate.attachments ?? []).map(\.id)
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
            var message = ChatMessage(
                id: uuidForServerID[item.id] ?? UUID(),
                role: role(item.role),
                text: item.text,
                timestamp: item.at,
                serverID: item.id,
                sourceNodeId: item.sourceNodeId,
                sourceName: item.sourceName,
                attachments: (item.attachments ?? []).map { preview in
                    local.first(where: { $0.id == uuidForServerID[item.id] })?.attachments.first(where: { $0.id == preview.id && $0.data != nil }) ?? preview
                }
            )
            message.requestID = item.requestId
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

// After a history refresh, decides what each reply whose stream was lost
// (accepted by main, `isDetached`) has become. The page is the newest one;
// `inFlight` is nil from a main that cannot say which turns are running.
enum ChatTurnRecovery {
    // Matches the dashboard: a turn can run several provider hops and tools.
    static let staleAfter: TimeInterval = 30 * 60
    static let interruptedText = "This reply stopped before it finished (OpenAGI restarted)."
    static let staleText = "No reply yet. OpenAGI may still be working on it."

    static func resolve(_ messages: [ChatMessage], page: ConversationPage, now: Date = Date()) -> [ChatMessage] {
        let running = Set((page.inFlight ?? []).map(\.requestId))
        var result: [ChatMessage] = []
        for var message in messages {
            guard message.isDetached, let id = message.requestID else { result.append(message); continue }
            // Main stored the reply (or its failure record): show that instead.
            if page.messages.contains(where: { $0.role == .assistant && $0.requestId == id }) { continue }
            if running.contains(id) {
                result.append(message)
                continue
            }
            let askedOnPage = page.messages.contains { $0.role == .user && $0.requestId == id }
            if askedOnPage && page.inFlight != nil {
                // Stored, not running, never answered: main lost it.
                result.append(failed(message, text: interruptedText, newRequest: true))
            } else if now.timeIntervalSince(message.timestamp) > staleAfter {
                result.append(failed(message, text: staleText, newRequest: false))
            } else {
                result.append(message)
            }
        }
        return result
    }

    private static func failed(_ message: ChatMessage, text: String, newRequest: Bool) -> ChatMessage {
        var failed = message
        failed.isStreaming = false
        failed.isDetached = false
        failed.activity = nil
        failed.isFailed = true
        failed.retrySafe = true
        failed.text = text
        failed.newRequestOnRetry = newRequest
        return failed
    }
}
