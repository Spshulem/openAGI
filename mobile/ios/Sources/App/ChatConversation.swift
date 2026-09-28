import Foundation
import Observation

// One shared conversation ("agent" for Chat, "supervisor" for Ask
// supervisor), owned by AppModel rather than by a view: a reply keeps
// streaming when the person switches tabs, and both the list and the
// in-flight state survive the screen going away and coming back.
//
// The daemon's shared thread is the source of truth -- every paired phone
// and G2 writes into it -- so this loads `GET /conversations/:thread/
// messages` on open, on foreground, after every reply, and whenever
// `/events` says the thread changed, and merges it into the local cache (see
// `ChatHistoryMerge`). The cache (`ChatHistoryStore`) is what shows while
// the daemon is out of reach, and on a main too old to have shared threads.
@Observable
@MainActor
final class ChatConversation {
    enum HistoryStatus: Equatable {
        case unknown
        case synced
        // The main answered 404: it predates shared threads. The phone's own
        // cache still shows; the header says how to get the shared history.
        case needsUpdate
        case offline
    }

    let thread: ConversationThread
    private(set) var messages: [ChatMessage]
    private(set) var isSending = false
    private(set) var historyStatus: HistoryStatus = .unknown

    private let client: DaemonClient
    private let store: ChatHistoryStore
    private let nodeID: String
    private let legacyConversationKey: String?
    // Responses can land out of order; one older than the last applied
    // refresh must not replace it.
    private var refreshIssued = 0
    private var refreshApplied = 0
    private var forgotten = false

    init(thread: ConversationThread, client: DaemonClient, store: ChatHistoryStore, nodeID: String) {
        self.thread = thread
        self.client = client
        self.store = store
        self.nodeID = nodeID
        // See DaemonClient.sendMessageStreaming: keeps an older main from
        // putting the supervisor chat in the same session as Chat.
        self.legacyConversationKey = thread == .supervisor ? "mobile-supervisor" : nil
        self.messages = store.load(nodeID: nodeID).map(ChatHistoryCodec.message)
    }

    // MARK: - Sending

    func send(_ rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        isSending = true
        defer { isSending = false }

        messages.append(ChatMessage(role: .user, text: text))
        let reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(reply)
        persist()
        await streamReply(text: text, replyID: reply.id)
    }

    // Re-sends the user message that preceded a failed reply, replacing just
    // that failed bubble in place rather than appending a new one --
    // "stays in place", per DESIGN.md, not a fresh row at the bottom.
    func retry(_ failedMessage: ChatMessage) async {
        guard let target = ChatRetry.target(failedID: failedMessage.id, in: messages, isSending: isSending) else { return }
        isSending = true
        defer { isSending = false }
        let fresh = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages[target.index] = fresh
        persist()
        await streamReply(text: target.userText, replyID: fresh.id)
    }

    private func streamReply(text: String, replyID: UUID) async {
        var sawTerminalFrame = false
        do {
            let stream = try await client.sendMessageStreaming(
                text: text, thread: thread, from: legacyConversationKey, sessionId: legacyConversationKey
            )
            for try await event in stream {
                guard let index = messages.firstIndex(where: { $0.id == replyID }) else { continue }
                switch event {
                case .delta(let frame):
                    if frame.reset {
                        messages[index].text = frame.text
                    } else {
                        messages[index].text += frame.text
                    }
                case .final(let frame):
                    sawTerminalFrame = true
                    if let reply = frame.reply, !reply.isEmpty {
                        messages[index].text = reply
                    } else if messages[index].text.isEmpty {
                        messages[index].text = "(no reply)"
                    }
                    messages[index].isStreaming = false
                case .failure(let frame):
                    sawTerminalFrame = true
                    fail(replyID, text: frame.error ?? "OpenAGI couldn't reply. Try again.")
                case .status, .session:
                    break
                }
            }
            // The daemon closes the stream only after `final` or `failure`;
            // anything else is a dropped connection mid-reply. The daemon may
            // still finish and store the reply -- the refresh below brings it
            // in and clears this failure if so.
            if !sawTerminalFrame {
                fail(replyID, text: "Reply stopped early. Try again.")
            }
        } catch let error as DaemonError {
            fail(replyID, text: ChatErrorCopy.message(for: error))
        } catch {
            fail(replyID, text: "Can't reach OpenAGI. Check your connection and try again.")
        }
        persist()
        await refresh()
    }

    private func fail(_ replyID: UUID, text: String) {
        guard let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        messages[index].text = text
        messages[index].isStreaming = false
        messages[index].isFailed = true
    }

    // MARK: - Shared history

    func refresh() async {
        guard !forgotten else { return }
        refreshIssued += 1
        let sequence = refreshIssued
        do {
            let page = try await client.conversationMessages(thread: thread)
            guard sequence > refreshApplied, !forgotten else { return }
            refreshApplied = sequence
            historyStatus = .synced
            let merged = ChatHistoryMerge.merge(local: messages, server: page.messages)
            if merged != messages {
                messages = merged
                persist()
            }
        } catch DaemonError.notFound {
            guard sequence > refreshApplied else { return }
            refreshApplied = sequence
            historyStatus = .needsUpdate
        } catch {
            guard sequence > refreshApplied else { return }
            refreshApplied = sequence
            historyStatus = .offline
        }
    }

    // Called after every change that should outlive the app: a send, a
    // finished or failed reply, a retry, a merge. A reply still streaming is
    // written as stopped (see ChatHistoryCodec), so a process kill mid-reply
    // comes back as "Reply stopped when the app closed." with "Try again".
    func persist() {
        guard !forgotten else { return }
        store.save(nodeID: nodeID, entries: messages.map(ChatHistoryCodec.saved))
    }

    // On revoke: the cache belongs to the pairing being forgotten, and a
    // reply still streaming must not write it back afterwards.
    func forget() {
        forgotten = true
        messages = []
        store.delete()
    }
}
