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
struct QueuedChatSubmission: Identifiable, Equatable {
    let id: UUID
    var text: String
    var attachments: [ChatAttachment]
    var focusedCardID: String?

    init(id: UUID = UUID(), text: String, attachments: [ChatAttachment], focusedCardID: String?) {
        self.id = id
        self.text = text
        self.attachments = attachments
        self.focusedCardID = focusedCardID
    }
}

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
    let conversationID: String
    let isReadOnly: Bool
    var identity: String { "\(thread.rawValue):\(conversationID)" }
    private(set) var messages: [ChatMessage]
    private(set) var isSending = false
    private(set) var queuedSubmissions: [QueuedChatSubmission] = []
    // Shared by compact and expanded presentations of this conversation.
    var draft = ""
    var draftAttachments: [ChatAttachment] = []
    var focusedCardID: String?
    private(set) var composerFocusRequest = 0
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
    // Finds replies whose stream was lost (see ChatTurnRecovery) while the
    // app is active. Polls history; never holds a stream in the background.
    private var recoveryTask: Task<Void, Never>?
    private var recoveryToken = UUID()
    private var lastPage: ConversationPage?

    init(thread: ConversationThread, client: DaemonClient, store: ChatHistoryStore, nodeID: String,
         conversationID: String = "main", isReadOnly: Bool = false) {
        self.thread = thread
        self.conversationID = conversationID
        self.isReadOnly = isReadOnly
        self.client = client
        self.store = store
        self.nodeID = nodeID
        // See DaemonClient.sendMessageStreaming: keeps an older main from
        // putting the supervisor chat in the same session as Chat.
        self.legacyConversationKey = thread == .supervisor ? "mobile-supervisor" : nil
        self.messages = ChatHistoryCodec.restored(store.load(nodeID: nodeID))
    }

    // MARK: - Sending

    var canSubmitDraft: Bool {
        !isReadOnly
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftAttachments.isEmpty)
            && draftAttachments.allSatisfy { $0.data != nil }
    }

    func removeQueuedSubmission(id: UUID) {
        queuedSubmissions.removeAll { $0.id == id }
    }

    func popQueuedSubmissionForEdit(id: UUID) -> QueuedChatSubmission? {
        guard let index = queuedSubmissions.firstIndex(where: { $0.id == id }) else { return nil }
        return queuedSubmissions.remove(at: index)
    }

    // Reserve the turn and reset the native editor in the same main-actor
    // transaction. Return-key and Send cannot race two unstructured tasks.
    @discardableResult
    func submitDraft() -> Bool {
        guard canSubmitDraft else { return false }
        let text = draft
        let attachments = draftAttachments
        if isSending {
            guard !forgotten else { return false }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let effective = trimmed.isEmpty ? "Please describe the attached images." : trimmed
            draft = ""
            draftAttachments = []
            composerRevision += 1
            queuedSubmissions.append(
                QueuedChatSubmission(text: effective, attachments: attachments, focusedCardID: focusedCardID)
            )
            return true
        }
        guard let turn = beginSend(text, attachments: attachments) else { return false }
        draft = ""
        draftAttachments = []
        composerRevision += 1
        let capturedFocus = focusedCardID
        Task { await finishSend(text: turn.text, attachments: attachments, replyID: turn.replyID, focusedCardID: capturedFocus) }
        return true
    }

    func send(_ rawText: String, attachments: [ChatAttachment] = []) async {
        guard let turn = beginSend(rawText, attachments: attachments) else { return }
        await finishSend(text: turn.text, attachments: attachments, replyID: turn.replyID, focusedCardID: focusedCardID)
    }

    private func beginSend(_ rawText: String, attachments: [ChatAttachment]) -> (text: String, replyID: UUID)? {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isReadOnly, !isSending, !forgotten, !trimmed.isEmpty || !attachments.isEmpty,
              attachments.allSatisfy({ $0.data != nil }) else { return nil }
        let text = trimmed.isEmpty ? "Please describe the attached images." : trimmed
        isSending = true
        appendTurn(text: text, attachments: attachments)
        return (text, messages[messages.count - 1].id)
    }

    // The user line and its reply placeholder, both named with a new turn id.
    private func appendTurn(text: String, attachments: [ChatAttachment]) {
        let requestID = Self.newRequestID()
        var user = ChatMessage(role: .user, text: text, attachments: attachments)
        user.requestID = requestID
        var reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        reply.requestID = requestID
        messages.append(user)
        messages.append(reply)
        persist()
    }

    static func newRequestID() -> String { "ios-" + UUID().uuidString.lowercased() }

    private func finishSend(text: String, attachments: [ChatAttachment], replyID: UUID, focusedCardID: String?) async {
        defer { isSending = false }
        await streamReply(text: text, attachments: attachments, replyID: replyID, focusedCardID: focusedCardID)
        while !forgotten, !queuedSubmissions.isEmpty {
            let next = queuedSubmissions.removeFirst()
            appendTurn(text: next.text, attachments: next.attachments)
            await streamReply(text: next.text, attachments: next.attachments, replyID: messages[messages.count - 1].id, focusedCardID: next.focusedCardID)
        }
    }

    // Re-sends the user message that preceded a failed reply, replacing just
    // that failed bubble in place rather than appending a new one --
    // "stays in place", per DESIGN.md, not a fresh row at the bottom.
    func retry(_ failedMessage: ChatMessage) async {
        guard !isReadOnly else { return }
        guard let target = ChatRetry.target(failedID: failedMessage.id, in: messages, isSending: isSending) else { return }
        isSending = true
        defer { isSending = false }
        // The same id: if main did get the first try, it replays or follows
        // that turn instead of running it again. A turn main lost is new.
        let failed = messages[target.index]
        var fresh = ChatMessage(role: .assistant, text: "", isStreaming: true)
        fresh.requestID = failed.newRequestOnRetry || failed.requestID == nil ? Self.newRequestID() : failed.requestID
        if fresh.requestID != failed.requestID,
           let userIndex = messages[..<target.index].lastIndex(where: { $0.role == .user }) {
            messages[userIndex].requestID = fresh.requestID
        }
        messages[target.index] = fresh
        persist()
        await streamReply(text: target.userText, attachments: target.attachments, replyID: fresh.id, focusedCardID: focusedCardID)
    }

    func requestComposerFocus() {
        composerFocusRequest += 1
    }

    private func streamReply(text: String, attachments: [ChatAttachment], replyID: UUID, focusedCardID: String? = nil) async {
        var sawTerminalFrame = false
        var openedStream = false
        let requestID = messages.first(where: { $0.id == replyID })?.requestID
        // Room to finish handing the turn to main if the app is backgrounded
        // right after Send. Ends at main's acknowledgement: the reply itself
        // never depends on staying awake.
        let grace = BackgroundTaskGuard(name: "chat-send")
        grace.begin(onExpire: {})
        defer { grace.end() }
        do {
            let stream = try await client.sendMessageStreaming(
                text: text, thread: thread, from: legacyConversationKey, sessionId: legacyConversationKey,
                attachments: attachments, conversationId: conversationID, focusedCardId: focusedCardID,
                requestId: requestID
            )
            openedStream = true
            for try await event in stream {
                guard let index = messages.firstIndex(where: { $0.id == replyID }) else { continue }
                switch event {
                case .delta(let frame):
                    // Text means main is running the turn, whatever frames
                    // came before it.
                    messages[index].accepted = true
                    // The working line stays under the text received so far
                    // until `final` (DESIGN.md); tokens don't clear it.
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
                    messages[index].activity = nil
                case .failure(let frame):
                    sawTerminalFrame = true
                    fail(replyID, text: (frame.error ?? "OpenAGI couldn't finish.") + " Check the conversation before sending again.")
                case .status(let frame):
                    if messages[index].isStreaming, let label = frame.activityLabel {
                        messages[index].activity = label
                    }
                case .session:
                    // Main has the turn: from here on it is never lost.
                    messages[index].accepted = true
                    grace.end()
                    persist()
                }
            }
            // The daemon closes the stream only after `final` or `failure`;
            // anything else is a dropped connection mid-reply.
            if !sawTerminalFrame { await connectionLost(replyID) }
        } catch let error as DaemonError {
            if !sawTerminalFrame {
                if !openedStream, error.isRejection {
                    fail(replyID, text: ChatErrorCopy.message(for: error),
                         retrySafe: error == .agentHostDisabled || error == .imagesUnsupported)
                } else {
                    await connectionLost(replyID)
                }
            }
        } catch {
            if !sawTerminalFrame { await connectionLost(replyID) }
        }
        persist()
        await refresh()
        startRecoveryIfNeeded()
    }

    // The stream went before `final`/`failure`. With turn ids main can say
    // what happened, so never ask the person to guess:
    // - accepted: main keeps working; find the reply in history.
    // - not confirmed: resending the same id is safe; do it once, offer Retry.
    // A main without turn ids keeps the old "check before resending".
    private func connectionLost(_ replyID: UUID) async {
        guard let before = messages.firstIndex(where: { $0.id == replyID }) else { return }
        let hasTurnID = messages[before].requestID != nil
        let mainSupportsTurnIDs = !(await client.turnIdsUnsupported)
        // Re-read: the list can change while this awaited.
        guard let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        if hasTurnID && mainSupportsTurnIDs {
            if messages[index].accepted {
                messages[index].isDetached = true
                messages[index].activity = ChatHistoryCodec.stillWorking
            } else {
                let images = messages[..<index].last(where: { $0.role == .user })?.attachments ?? []
                fail(replyID, text: ChatHistoryCodec.unconfirmedText, retrySafe: images.allSatisfy { $0.data != nil })
                messages[index].autoRetry = true
            }
        } else {
            fail(replyID, text: Self.connectionLostText)
        }
    }

    static let connectionLostText = "Connection lost. This turn may still be running or may have finished. Check the conversation before sending again."

    // Opening the chat, or the app becoming active: catch up with main,
    // keep finding replies whose stream was lost, and resend (once, same id)
    // a send main never confirmed.
    func resume() async {
        await refresh()
        startRecoveryIfNeeded()
        if historyStatus == .synced, !isSending,
           let pending = messages.first(where: { $0.isFailed && $0.autoRetry && $0.retrySafe }) {
            if let index = messages.firstIndex(where: { $0.id == pending.id }) {
                messages[index].autoRetry = false
            }
            await retry(pending)
        }
    }

    // Stops polling when the app leaves the foreground; `resume` restarts it.
    func pauseRecovery() {
        recoveryTask?.cancel()
        recoveryTask = nil
    }

    private func startRecoveryIfNeeded() {
        guard recoveryTask == nil, !forgotten, messages.contains(where: \.isDetached) else { return }
        let token = UUID()
        recoveryToken = token
        recoveryTask = Task { [weak self] in
            var delay: UInt64 = 2
            while let self, !Task.isCancelled, !self.forgotten, self.messages.contains(where: \.isDetached) {
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                if Task.isCancelled { break }
                await self.refresh()
                delay = min(delay * 2, 15)
            }
            if self?.recoveryToken == token { self?.recoveryTask = nil }
        }
    }

    private func fail(_ replyID: UUID, text: String, retrySafe: Bool = false) {
        guard let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        messages[index].text = text
        messages[index].isStreaming = false
        messages[index].activity = nil
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
            let page = try await client.conversationMessages(thread: thread, conversationId: conversationID)
            guard sequence > refreshApplied, !forgotten else { return }
            refreshApplied = sequence
            historyStatus = .synced
            let pageIDs = Set(page.messages.map(\.id))
            let overlaps = messages.contains { message in
                message.serverID.map(pageIDs.contains) ?? false
            }
            lastPage = page
            let merged = ChatTurnRecovery.resolve(ChatHistoryMerge.merge(local: messages, server: page.messages), page: page)
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
            // No shared history on this main, so a lost reply can't be found
            // again: say so plainly, and don't offer a blind resend.
            for index in messages.indices where messages[index].isDetached {
                fail(messages[index].id, text: Self.connectionLostText)
                messages[index].isDetached = false
            }
            persist()
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
            let page = try await client.conversationMessages(thread: thread, before: cursor, conversationId: conversationID)
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
        pauseRecovery()
        forgotten = true
    }

    // On revoke: the cache belongs to the pairing being forgotten, and a
    // reply still streaming must not write it back afterwards.
    func forget() {
        draft = ""
        draftAttachments = []
        queuedSubmissions = []
        focusedCardID = nil
        composerRevision += 1
        pauseRecovery()
        forgotten = true
        messages = []
        nextBefore = nil
        olderHistoryError = nil
        store.delete()
    }
}
