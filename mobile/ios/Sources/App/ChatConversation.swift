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
        case needsPairing
    }

    let thread: ConversationThread
    private(set) var messages: [ChatMessage]
    private(set) var isSending = false
    // Shared by compact and expanded presentations of this conversation.
    var draft = ""
    var draftAttachments: [ChatAttachment] = []
    private(set) var composerRevision = 0
    private(set) var historyStatus: HistoryStatus = .unknown
    private(set) var isRefreshingHistory = false
    private(set) var isLoadingOlder = false
    private(set) var olderHistoryError: String?
    private(set) var nextBefore: String?

    private let client: DaemonClient
    private let store: ChatHistoryStore
    private let nodeID: String
    private let legacyConversationKey: String?
    // Responses can land out of order; one older than the last applied
    // refresh must not replace it.
    private var refreshIssued = 0
    private var refreshApplied = 0
    private var activeRefreshes = 0
    private var didLoadOlder = false
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

    var canSubmitDraft: Bool {
        !isSending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftAttachments.isEmpty)
    }

    // Reserve the turn and reset the native editor in the same main-actor
    // transaction. Return-key and Send cannot race two unstructured tasks.
    @discardableResult
    func submitDraft() -> Bool {
        guard canSubmitDraft else { return false }
        let text = draft
        let attachments = draftAttachments
        guard let turn = beginSend(text, attachments: attachments) else { return false }
        draft = ""
        draftAttachments = []
        composerRevision += 1
        Task { await finishSend(text: turn.text, attachments: attachments, replyID: turn.replyID) }
        return true
    }

    func send(_ rawText: String, attachments: [ChatAttachment] = []) async {
        guard let turn = beginSend(rawText, attachments: attachments) else { return }
        await finishSend(text: turn.text, attachments: attachments, replyID: turn.replyID)
    }

    private func beginSend(_ rawText: String, attachments: [ChatAttachment]) -> (text: String, replyID: UUID)? {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSending, !forgotten, !trimmed.isEmpty || !attachments.isEmpty,
              attachments.allSatisfy({ $0.data != nil }) else { return nil }
        let text = trimmed.isEmpty ? "Please describe the attached images." : trimmed
        isSending = true
        messages.append(ChatMessage(role: .user, text: text, attachments: attachments))
        let reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(reply)
        persist()
        return (text, reply.id)
    }

    private func finishSend(text: String, attachments: [ChatAttachment], replyID: UUID) async {
        defer { isSending = false }
        await streamReply(text: text, attachments: attachments, replyID: replyID)
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
        await streamReply(text: target.userText, attachments: target.attachments, replyID: fresh.id)
    }

    private func streamReply(text: String, attachments: [ChatAttachment], replyID: UUID) async {
        var sawTerminalFrame = false
        do {
            let stream = try await client.sendMessageStreaming(
                text: text, thread: thread, from: legacyConversationKey, sessionId: legacyConversationKey, attachments: attachments
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
                    fail(replyID, text: (frame.error ?? "OpenAGI couldn't finish.") + " Check the conversation before sending again.")
                case .status, .session:
                    break
                }
            }
            // The daemon closes the stream only after `final` or `failure`;
            // anything else is a dropped connection mid-reply. The daemon may
            // still finish and store the reply -- the refresh below brings it
            // in and clears this failure if so.
            if !sawTerminalFrame {
                fail(replyID, text: "Connection lost. This turn may still be running or may have finished. Check the conversation before sending again.")
            }
        } catch let error as DaemonError {
            if !sawTerminalFrame {
                fail(replyID, text: error == .agentHostDisabled || error == .unauthorized || error == .imagesUnsupported
                     ? ChatErrorCopy.message(for: error)
                     : "Connection lost. This turn may still be running or may have finished. Check the conversation before sending again.",
                     retrySafe: error == .agentHostDisabled)
            }
        } catch {
            if !sawTerminalFrame {
                fail(replyID, text: "Connection lost. This turn may still be running or may have finished. Check the conversation before sending again.")
            }
        }
        persist()
        await refresh()
    }

    private func fail(_ replyID: UUID, text: String, retrySafe: Bool = false) {
        guard let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        messages[index].text = text
        messages[index].isStreaming = false
        messages[index].isFailed = true
        messages[index].retrySafe = retrySafe
    }

    // MARK: - Shared history

    func refresh() async {
        guard !forgotten else { return }
        activeRefreshes += 1
        isRefreshingHistory = true
        defer {
            activeRefreshes -= 1
            isRefreshingHistory = activeRefreshes > 0
        }
        refreshIssued += 1
        let sequence = refreshIssued
        do {
            let page = try await client.conversationMessages(thread: thread)
            guard sequence > refreshApplied, !forgotten else { return }
            refreshApplied = sequence
            historyStatus = .synced
            let pageIDs = Set(page.messages.map(\.id))
            let overlaps = messages.contains { message in
                message.serverID.map(pageIDs.contains) ?? false
            }
            let merged = ChatHistoryMerge.merge(local: messages, server: page.messages)
            if merged != messages {
                messages = merged
                persist()
            }
            if !didLoadOlder || !overlaps {
                // Start at the returned page, not the oldest cached line:
                // time spent offline can leave an unloaded gap in between.
                nextBefore = page.nextBefore
                didLoadOlder = false
            }
        } catch DaemonError.notFound {
            guard sequence > refreshApplied, !forgotten else { return }
            refreshApplied = sequence
            historyStatus = .needsUpdate
        } catch DaemonError.unauthorized {
            guard sequence > refreshApplied, !forgotten else { return }
            refreshApplied = sequence
            historyStatus = .needsPairing
        } catch {
            guard sequence > refreshApplied, !forgotten else { return }
            refreshApplied = sequence
            historyStatus = .offline
        }
    }

    func loadOlder() async {
        guard !forgotten, !isLoadingOlder, let cursor = nextBefore else { return }
        isLoadingOlder = true
        olderHistoryError = nil
        defer { isLoadingOlder = false }
        do {
            let page = try await client.conversationMessages(thread: thread, before: cursor)
            guard !forgotten, nextBefore == cursor else { return }
            messages = ChatHistoryMerge.prependOlder(local: messages, server: page.messages, before: cursor)
            nextBefore = page.nextBefore
            didLoadOlder = true
            persist()
        } catch {
            guard !forgotten else { return }
            olderHistoryError = "Couldn't load earlier messages. Try again."
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

    // Stop late replies/history refreshes from writing while setup is open,
    // keeping the last saved conversation available if setup is cancelled.
    func suspend() {
        persist()
        forgotten = true
    }

    // On revoke: the cache belongs to the pairing being forgotten, and a
    // reply still streaming must not write it back afterwards.
    func forget() {
        draft = ""
        draftAttachments = []
        composerRevision += 1
        forgotten = true
        messages = []
        nextBefore = nil
        olderHistoryError = nil
        store.delete()
    }
}
