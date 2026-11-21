import Foundation
import Observation

// One message the person sent, kept in the conversation's outbox
// (`ChatHistoryStore.saveOutbox`) from the moment Send is tapped until main
// has accepted it. It is named with its turn id at that moment, so however
// often the connection drops, the app is killed, or the item is checked
// again, main runs it at most once (mobile/PROTOCOL.md §3.1).
struct QueuedChatSubmission: Identifiable, Equatable, Sendable {
    enum State: String, Sendable {
        // Waiting its turn. Safe to send with its id.
        case queued
        // Posted; main has not confirmed it yet.
        case sending
        // The connection went before main confirmed it: asked about (turns
        // route) before it is ever sent again.
        case notSent
        // Needs the person: Retry or Remove.
        case failed
    }

    let id: UUID
    var requestID: String
    var text: String
    var attachments: [ChatAttachment]
    var focusedCardID: String?
    var createdAt: Date
    var state: State = .queued
    // A POST with this id may have reached main.
    var maybeDelivered = false
    var failureText: String?
    // Main finished or lost this id: a retry is a new turn.
    var retryNeedsNewID = false
    // Shown in the Queued tray. An idle send goes straight to the
    // conversation instead, so it never flashes through the tray.
    var shownQueued = true

    init(id: UUID = UUID(), requestID: String = ChatConversation.newRequestID(), text: String,
         attachments: [ChatAttachment], focusedCardID: String?, createdAt: Date = Date()) {
        self.id = id
        self.requestID = requestID
        self.text = text
        self.attachments = attachments
        self.focusedCardID = focusedCardID
        self.createdAt = createdAt
    }

    // Only something main can never have seen may be changed.
    var isEditable: Bool { !maybeDelivered && state != .sending }
    var canRetry: Bool { state == .failed && attachments.allSatisfy { $0.data != nil } }

    init(saved: SavedOutboxItem) {
        id = saved.id
        requestID = saved.requestID
        text = saved.text
        attachments = saved.attachments
        focusedCardID = saved.focusedCardID
        createdAt = saved.createdAt
        state = State(rawValue: saved.state) ?? .failed
        maybeDelivered = saved.maybeDelivered
        failureText = saved.failureText
        retryNeedsNewID = saved.retryNeedsNewID ?? false
        shownQueued = saved.shownQueued ?? true
        if state == .failed, failureText == nil { failureText = ChatConversation.itemFailedText }
    }

    var saved: SavedOutboxItem {
        SavedOutboxItem(id: id, requestID: requestID, text: text, attachments: attachments, focusedCardID: focusedCardID,
                        createdAt: createdAt, state: state.rawValue, maybeDelivered: maybeDelivered, failureText: failureText,
                        retryNeedsNewID: retryNeedsNewID ? true : nil, shownQueued: shownQueued)
    }
}

// What the Queued tray says about one item.
enum QueuedChatDisplayState: Equatable {
    case queued
    case sending
    // Paused behind this phone's own turn whose stream was lost.
    case waiting
    case notSent
    case failed(String)
}

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
//
// Sends go through a durable outbox, one turn at a time: the next message
// goes only after main finished the previous one. A turn whose stream was
// lost, or a send main never confirmed, pauses the rest until main says
// what happened -- reconnecting must never fire the whole queue at once.
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

    // How one turn's stream ended.
    enum TurnOutcome: Equatable {
        case finished
        // A `failure` frame: main ran the turn and recorded the failure.
        case failedOnServer
        // Refused before anything ran (an HTTP error on `/message`).
        case rejected
        // Main accepted it, then the stream was lost: still working.
        case detached
        // The connection went before main confirmed it.
        case unconfirmed
        // Lost on a main without turn ids: nothing can be checked.
        case lost

        // Only a turn main finished lets the next one go.
        var letsNextGo: Bool { self == .finished || self == .failedOnServer }
    }

    let thread: ConversationThread
    let conversationID: String
    let isReadOnly: Bool
    var identity: String { "\(thread.rawValue):\(conversationID)" }
    private(set) var messages: [ChatMessage]
    private(set) var isSending = false
    // Oldest first. Persisted on every change, before any network I/O.
    private var outbox: [QueuedChatSubmission] = []
    // The tray: everything waiting, except an idle send already showing in
    // the conversation.
    var queuedSubmissions: [QueuedChatSubmission] {
        outbox.filter { $0.state != .sending || $0.shownQueued }
    }
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
    // Two ChatViews (compact and expanded) both call `resume`; only one
    // may check with main and send at a time.
    private var isResuming = false
    private var isReconciling = false
    private var drainTask: Task<Void, Never>?
    // Turns the turns route last called queued or running.
    private var activeTurnIDs: Set<String> = []
    // The main answered 404 for the turns route. In memory: a relaunch asks
    // again, so an updated main is picked up.
    private var turnsRouteMissing = false

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
        self.outbox = store.loadOutbox(nodeID: nodeID).map(QueuedChatSubmission.init(saved:))
        restoreOutbox()
    }

    // MARK: - Sending

    var canSubmitDraft: Bool {
        !isReadOnly
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftAttachments.isEmpty)
            && draftAttachments.allSatisfy { $0.data != nil }
    }

    func displayState(of item: QueuedChatSubmission) -> QueuedChatDisplayState {
        switch item.state {
        case .sending: return .sending
        case .notSent: return .notSent
        case .failed: return .failed(item.failureText ?? Self.itemFailedText)
        case .queued:
            if messages.contains(where: \.isDetached) { return .waiting }
            return historyStatus == .offline ? .notSent : .queued
        }
    }

    func removeQueuedSubmission(id: UUID) {
        guard let index = outbox.firstIndex(where: { $0.id == id }), outbox[index].state != .sending else { return }
        outbox.remove(at: index)
        persistOutbox()
        drainIfPossible()
    }

    func popQueuedSubmissionForEdit(id: UUID) -> QueuedChatSubmission? {
        guard let index = outbox.firstIndex(where: { $0.id == id }), outbox[index].isEditable else { return nil }
        let item = outbox.remove(at: index)
        persistOutbox()
        drainIfPossible()
        return item
    }

    // The tray's Retry on a failed item. A turn main finished or lost is
    // sent as a new turn; one main may not have seen keeps its id.
    func retryQueuedSubmission(id: UUID) {
        guard let index = outbox.firstIndex(where: { $0.id == id }), outbox[index].canRetry else { return }
        if outbox[index].retryNeedsNewID {
            outbox[index].requestID = Self.newRequestID()
            outbox[index].maybeDelivered = false
            outbox[index].retryNeedsNewID = false
        }
        outbox[index].state = .queued
        outbox[index].failureText = nil
        persistOutbox()
        drainIfPossible()
    }

    // Reserve the turn and reset the native editor in the same main-actor
    // transaction. Return-key and Send cannot race two unstructured tasks.
    @discardableResult
    func submitDraft() -> Bool {
        guard canSubmitDraft, !forgotten else { return false }
        guard enqueue(draft, attachments: draftAttachments, focusedCardID: focusedCardID) else { return false }
        draft = ""
        draftAttachments = []
        composerRevision += 1
        return true
    }

    func send(_ rawText: String, attachments: [ChatAttachment] = []) async {
        guard enqueue(rawText, attachments: attachments, focusedCardID: focusedCardID) else { return }
        await drainTask?.value
    }

    private func enqueue(_ rawText: String, attachments: [ChatAttachment], focusedCardID: String?) -> Bool {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isReadOnly, !forgotten, !trimmed.isEmpty || !attachments.isEmpty,
              attachments.allSatisfy({ $0.data != nil }) else { return false }
        let text = trimmed.isEmpty ? "Please describe the attached images." : trimmed
        // On disk before anything touches the network: from here on a kill
        // neither loses it nor sends it twice. Same text twice is two items.
        let item = QueuedChatSubmission(text: text, attachments: attachments, focusedCardID: focusedCardID)
        outbox.append(item)
        persistOutbox()
        drainIfPossible()
        if let index = outbox.firstIndex(where: { $0.id == item.id }), outbox[index].state == .sending {
            // Sent straight away: the conversation shows it, not the tray.
            outbox[index].shownQueued = false
            persistOutbox()
        }
        return true
    }

    // Starts sending the oldest item when nothing else is going on. Never
    // past a turn of this phone's that main may still be running.
    private func drainIfPossible() {
        guard !isSending, !isReconciling, !forgotten, !isReadOnly, !outbox.isEmpty else { return }
        if historyStatus == .offline || outbox.first?.state == .notSent {
            // Check the connection, and what main already has, first.
            if !isResuming { Task { await resume() } }
            return
        }
        guard let turn = dispatchNext() else { return }
        drainTask = Task { await runDrain(from: turn) }
    }

    private struct Dispatch {
        let replyID: UUID
        let text: String
        let attachments: [ChatAttachment]
        let focusedCardID: String?
    }

    // Moves the oldest queued item into the conversation and marks it
    // sending (on disk first). Synchronous, so two taps cannot both start.
    private func dispatchNext() -> Dispatch? {
        guard !forgotten, !isReadOnly, historyStatus != .offline, !hasUnsettledOwnTurn,
              let head = outbox.first, head.state == .queued else { return nil }
        guard head.attachments.allSatisfy({ $0.data != nil }) else {
            // Never send a message without the images it was written with.
            outbox[0].state = .failed
            outbox[0].failureText = Self.missingImageText
            persistOutbox()
            return nil
        }
        outbox[0].state = .sending
        outbox[0].maybeDelivered = true
        persistOutbox()
        isSending = true
        appendTurn(text: head.text, attachments: head.attachments, requestID: head.requestID)
        return Dispatch(replyID: messages[messages.count - 1].id, text: head.text,
                        attachments: head.attachments, focusedCardID: head.focusedCardID)
    }

    // A turn of this phone's that main may still be running (its stream was
    // lost), or a send from before the outbox not yet checked with main.
    private var hasUnsettledOwnTurn: Bool {
        messages.contains { $0.isDetached || ($0.isFailed && $0.autoRetry && $0.requestID != nil) }
    }

    private func runDrain(from first: Dispatch) async {
        defer { isSending = false }
        var current: Dispatch? = first
        while let turn = current {
            let outcome = await streamReply(text: turn.text, attachments: turn.attachments, replyID: turn.replyID,
                                            focusedCardID: turn.focusedCardID)
            // Anything but a finished turn leaves the rest queued: main may
            // still be running this one, and would queue them all behind it.
            guard outcome.letsNextGo, !forgotten else { break }
            current = dispatchNext()
        }
    }

    // The user line and its reply placeholder, both named with the turn id.
    private func appendTurn(text: String, attachments: [ChatAttachment], requestID: String) {
        var user = ChatMessage(role: .user, text: text, attachments: attachments)
        user.requestID = requestID
        var reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        reply.requestID = requestID
        messages.append(user)
        messages.append(reply)
        persist()
    }

    nonisolated static func newRequestID() -> String { "ios-" + UUID().uuidString.lowercased() }

    // Re-sends the user message that preceded a failed reply, replacing just
    // that failed bubble in place rather than appending a new one --
    // "stays in place", per DESIGN.md, not a fresh row at the bottom.
    @discardableResult
    func retry(_ failedMessage: ChatMessage) async -> TurnOutcome? {
        guard !isReadOnly else { return nil }
        guard let target = ChatRetry.target(failedID: failedMessage.id, in: messages, isSending: isSending) else { return nil }
        isSending = true
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
        let outcome = await streamReply(text: target.userText, attachments: target.attachments, replyID: fresh.id, focusedCardID: focusedCardID)
        isSending = false
        if outcome.letsNextGo { drainIfPossible() }
        return outcome
    }

    func requestComposerFocus() {
        composerFocusRequest += 1
    }

    @discardableResult
    private func streamReply(text: String, attachments: [ChatAttachment], replyID: UUID, focusedCardID: String? = nil) async -> TurnOutcome {
        var outcome: TurnOutcome?
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
                    if !messages[index].accepted { markAccepted(index) }
                    // The working line stays under the text received so far
                    // until `final` (DESIGN.md); tokens don't clear it.
                    if frame.reset {
                        messages[index].text = frame.text
                    } else {
                        messages[index].text += frame.text
                    }
                case .final(let frame):
                    outcome = .finished
                    if let reply = frame.reply, !reply.isEmpty {
                        messages[index].text = reply
                    } else if messages[index].text.isEmpty {
                        messages[index].text = "(no reply)"
                    }
                    messages[index].isStreaming = false
                    messages[index].activity = nil
                case .failure(let frame):
                    outcome = .failedOnServer
                    fail(replyID, text: (frame.error ?? "OpenAGI couldn't finish.") + " Check the conversation before sending again.")
                case .status(let frame):
                    if messages[index].isStreaming, let label = frame.activityLabel {
                        messages[index].activity = label
                    }
                case .session:
                    // Main has the turn: from here on it is never lost.
                    markAccepted(index)
                    grace.end()
                }
            }
            // The daemon closes the stream only after `final` or `failure`;
            // anything else is a dropped connection mid-reply.
            if outcome == nil { outcome = await connectionLost(replyID) }
        } catch let error as DaemonError {
            if outcome == nil {
                if !openedStream, error.isRejection {
                    fail(replyID, text: ChatErrorCopy.message(for: error),
                         retrySafe: error == .agentHostDisabled || error == .imagesUnsupported)
                    outcome = .rejected
                } else {
                    outcome = await connectionLost(replyID)
                }
            }
        } catch {
            if outcome == nil { outcome = await connectionLost(replyID) }
        }
        let result = outcome ?? .lost
        settleOutbox(requestID: requestID, outcome: result)
        persist()
        await refresh()
        startRecoveryIfNeeded()
        return result
    }

    // Main accepted the turn. Saved first (a relaunch then recovers it as
    // still working), then it leaves the outbox: main holds a durable
    // receipt for it from here on.
    private func markAccepted(_ index: Int) {
        messages[index].accepted = true
        persist()
        guard let id = messages[index].requestID,
              let item = outbox.firstIndex(where: { $0.requestID == id && $0.state == .sending }) else { return }
        outbox.remove(at: item)
        persistOutbox()
    }

    // What an outbox turn becomes once its stream ended.
    private func settleOutbox(requestID: String?, outcome: TurnOutcome) {
        guard let requestID, let index = outbox.firstIndex(where: { $0.requestID == requestID }) else { return }
        if outcome == .unconfirmed {
            // Back to the front of the tray, out of the conversation. Sent
            // again (same id) only once main says it never got it.
            messages.removeAll { $0.requestID == requestID && $0.serverID == nil }
            outbox[index].state = .notSent
            outbox[index].shownQueued = true
        } else {
            // Finished, failed, refused, or accepted: the conversation shows
            // it from here (or recovers it), never the outbox.
            outbox.remove(at: index)
        }
        persistOutbox()
    }

    // The stream went before `final`/`failure`. With turn ids main can say
    // what happened, so never ask the person to guess:
    // - accepted: main keeps working; find the reply in history.
    // - not confirmed: ask main about the id (turns route) before resending.
    // A main without turn ids keeps the old "check before resending".
    private func connectionLost(_ replyID: UUID) async -> TurnOutcome {
        guard let before = messages.firstIndex(where: { $0.id == replyID }) else { return .lost }
        let hasTurnID = messages[before].requestID != nil
        let mainSupportsTurnIDs = !(await client.turnIdsUnsupported)
        // Re-read: the list can change while this awaited.
        guard let index = messages.firstIndex(where: { $0.id == replyID }) else { return .lost }
        if hasTurnID && mainSupportsTurnIDs {
            if messages[index].accepted {
                messages[index].isDetached = true
                messages[index].activity = ChatHistoryCodec.stillWorking
                return .detached
            }
            let images = messages[..<index].last(where: { $0.role == .user })?.attachments ?? []
            fail(replyID, text: ChatHistoryCodec.unconfirmedText, retrySafe: images.allSatisfy { $0.data != nil })
            messages[index].autoRetry = true
            return .unconfirmed
        }
        fail(replyID, text: Self.connectionLostText)
        return .lost
    }

    nonisolated static let connectionLostText = "Connection lost. This turn may still be running or may have finished. Check the conversation before sending again."
    nonisolated static let itemFailedText = "OpenAGI couldn't finish this message. Check the conversation, then retry or remove it."
    nonisolated static let unconfirmedItemText = "OpenAGI didn't confirm it got this message. Check the conversation before sending again."
    nonisolated static let missingImageText = "An image in this message couldn't be restored. Remove the message and attach the image again."

    // Opening the chat, or the app becoming active: catch up with main,
    // keep finding replies whose stream was lost, settle sends main never
    // confirmed, and carry on with the queue one turn at a time.
    func resume() async {
        guard !isResuming else { return }
        isResuming = true
        defer { isResuming = false }
        await refresh()
        startRecoveryIfNeeded()
        await reconcileAndDrain()
    }

    // Asks main about every turn of this phone's whose outcome is unknown,
    // resends (same id) only what main says it never got, one at a time,
    // then sends the queue -- each item only after the previous finished.
    private func reconcileAndDrain() async {
        guard !isReconciling, !isSending, !forgotten, !isReadOnly,
              historyStatus == .synced || historyStatus == .needsUpdate else { return }
        isReconciling = true
        defer { isReconciling = false }
        // Bounded: each pass either resends one line or stops.
        for _ in 0..<ChatHistoryStore.maxEntries {
            guard case .ready(let pending) = await reconcileWithMain(), !isSending, !forgotten else { return }
            if messages.contains(where: \.isDetached) {
                startRecoveryIfNeeded()
                return
            }
            if ownTurnInFlight { return }
            guard let resend = pending else { break }
            guard let outcome = await retry(resend), outcome.letsNextGo, !forgotten else { return }
        }
        guard !isSending, let turn = dispatchNext() else { return }
        let task = Task { await runDrain(from: turn) }
        drainTask = task
        await task.value
    }

    // The newest page lists a turn of this phone's as still running.
    private var ownTurnInFlight: Bool {
        let running = Set((lastPage?.inFlight ?? []).map(\.requestId))
        guard !running.isEmpty else { return false }
        return outbox.contains { running.contains($0.requestID) }
            || messages.contains { ($0.isFailed || $0.isStreaming) && $0.requestID.map(running.contains) == true }
    }

    private enum Reconciled {
        case blocked
        // Checked; resend this line (same id) next, if any.
        case ready(ChatMessage?)
    }

    private func reconcileWithMain() async -> Reconciled {
        let lineIDs = messages.filter { $0.role == .assistant && $0.isFailed && $0.autoRetry }.compactMap(\.requestID)
        let itemIDs = outbox.filter { $0.state == .notSent }.map(\.requestID)
        let detachedIDs = messages.filter(\.isDetached).compactMap(\.requestID)
        var ids: [String] = []
        for id in lineIDs + itemIDs + detachedIDs where !ids.contains(id) { ids.append(id) }
        guard !ids.isEmpty else { return .ready(nil) }
        var answer: ConversationTurns?
        if !turnsRouteMissing {
            do {
                answer = try await client.conversationTurns(thread: thread, ids: Array(ids.prefix(50)), conversationId: conversationID)
            } catch DaemonError.notFound {
                turnsRouteMissing = true
            } catch DaemonError.malformedResponse {
                turnsRouteMissing = true
            } catch {
                // Can't ask now: wait, and never guess.
                return .blocked
            }
        }
        guard !forgotten, !isSending else { return .blocked }
        guard let answer else {
            settleWithoutTurnsRoute()
            return .ready(nil)
        }
        var states: [String: ConversationTurnStatus.State] = [:]
        for turn in answer.turns where states[turn.requestId] == nil { states[turn.requestId] = turn.state }
        activeTurnIDs = Set(states.filter { $0.value == .queued || $0.value == .running }.keys)
        var needsRefresh = false
        var resend: ChatMessage?

        // Lines from before the outbox (or a resend): a send main never
        // confirmed, shown in the conversation as "Not sent".
        for id in lineIDs {
            guard let state = states[id],
                  let index = messages.lastIndex(where: { $0.role == .assistant && $0.isFailed && $0.autoRetry && $0.requestID == id })
            else { continue }
            switch state {
            case .done, .failed:
                // Main finished it: history has its reply or failure record.
                messages.remove(at: index)
                needsRefresh = true
            case .interrupted:
                messages[index].autoRetry = false
                messages[index].text = ChatTurnRecovery.interruptedText
                messages[index].newRequestOnRetry = true
            case .queued, .running:
                messages[index] = Self.detachedReply(messages[index])
            case .unknown:
                if ChatRetry.target(failedID: messages[index].id, in: messages, isSending: false) == nil {
                    // Its images are gone: only the person can send it again.
                    messages[index].autoRetry = false
                } else if resend == nil {
                    resend = messages[index]
                }
            }
        }

        for id in itemIDs {
            guard let state = states[id], let index = outbox.firstIndex(where: { $0.requestID == id && $0.state == .notSent }) else { continue }
            switch state {
            case .done:
                outbox.remove(at: index)
                needsRefresh = true
            case .failed:
                outbox[index].state = .failed
                outbox[index].failureText = Self.itemFailedText
                outbox[index].retryNeedsNewID = true
            case .interrupted:
                outbox[index].state = .failed
                outbox[index].failureText = ChatTurnRecovery.interruptedText
                outbox[index].retryNeedsNewID = true
            case .queued, .running:
                // Main has it: follow it like any turn whose stream was lost.
                appendDetachedTurn(for: outbox.remove(at: index))
            case .unknown:
                // Main never got it: send it again, with the same id.
                outbox[index].state = .queued
            }
        }

        for id in detachedIDs {
            guard let state = states[id], let index = messages.firstIndex(where: { $0.isDetached && $0.requestID == id }) else { continue }
            switch state {
            case .done, .failed:
                needsRefresh = true
            case .interrupted:
                fail(messages[index].id, text: ChatTurnRecovery.interruptedText, retrySafe: true)
                messages[index].isDetached = false
                messages[index].newRequestOnRetry = true
            case .unknown:
                // Main restarted before starting it: the next pass resends it.
                let images = messages[..<index].last(where: { $0.role == .user })?.attachments ?? []
                fail(messages[index].id, text: ChatHistoryCodec.unconfirmedText, retrySafe: images.allSatisfy { $0.data != nil })
                messages[index].isDetached = false
                messages[index].autoRetry = true
            case .queued, .running:
                break
            }
        }
        persist()
        persistOutbox()
        if needsRefresh { await refresh() }
        return .ready(resend)
    }

    // A main without the turns route cannot say whether it got a send, so
    // nothing unconfirmed is resent on its own: the person decides.
    private func settleWithoutTurnsRoute() {
        for index in messages.indices where messages[index].role == .assistant && messages[index].isFailed && messages[index].autoRetry {
            messages[index].autoRetry = false
            messages[index].text = Self.connectionLostText
        }
        for index in outbox.indices where outbox[index].state == .notSent {
            outbox[index].state = .failed
            outbox[index].failureText = Self.unconfirmedItemText
            outbox[index].retryNeedsNewID = false
        }
        persist()
        persistOutbox()
    }

    private static func detachedReply(_ line: ChatMessage) -> ChatMessage {
        var reply = line
        reply.text = ""
        reply.isFailed = false
        reply.isStreaming = true
        reply.autoRetry = false
        reply.accepted = true
        reply.isDetached = true
        reply.activity = ChatHistoryCodec.stillWorking
        return reply
    }

    private func appendDetachedTurn(for item: QueuedChatSubmission) {
        if !messages.contains(where: { $0.role == .user && $0.requestID == item.requestID }) {
            var user = ChatMessage(role: .user, text: item.text, attachments: item.attachments)
            user.requestID = item.requestID
            messages.append(user)
        }
        var reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        reply.requestID = item.requestID
        messages.append(Self.detachedReply(reply))
    }

    // After a relaunch: an item that was mid-send is either already
    // accepted (its reply is being recovered) or unconfirmed.
    private func restoreOutbox() {
        guard !outbox.isEmpty else { return }
        var kept: [QueuedChatSubmission] = []
        for var item in outbox {
            if item.state == .sending {
                if messages.contains(where: { $0.requestID == item.requestID && $0.isDetached }) { continue }
                messages.removeAll { $0.requestID == item.requestID && $0.serverID == nil }
                item.state = .notSent
                item.shownQueued = true
            }
            if item.state != .failed, item.attachments.contains(where: { $0.data == nil }) {
                item.state = .failed
                item.failureText = Self.missingImageText
            }
            kept.append(item)
        }
        outbox = kept
        persist()
        persistOutbox()
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
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                // Re-check after waking: the reply may have arrived meanwhile
                // (another refresh, an /events update), or the chat was closed.
                guard let self, !Task.isCancelled, !self.forgotten,
                      self.messages.contains(where: \.isDetached) else { break }
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
            let merged = ChatTurnRecovery.resolve(ChatHistoryMerge.merge(local: messages, server: page.messages), page: page,
                                                  alsoRunning: activeTurnIDs)
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
            continueQueueIfIdle()
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
            continueQueueIfIdle()
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

    // A refresh can be what unblocks the queue: the connection is back, or
    // the reply to a turn whose stream was lost has arrived.
    private func continueQueueIfIdle() {
        guard !outbox.isEmpty, !isResuming, !isReconciling, !isSending, !forgotten else { return }
        Task { await reconcileAndDrain() }
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

    private func persistOutbox() {
        guard !forgotten else { return }
        store.saveOutbox(nodeID: nodeID, items: outbox.map(\.saved))
    }

    // Stop late replies/history refreshes from writing while setup is open,
    // keeping the last saved conversation available if setup is cancelled.
    func suspend() {
        persist()
        persistOutbox()
        pauseRecovery()
        forgotten = true
    }

    // On revoke: the cache belongs to the pairing being forgotten, and a
    // reply still streaming must not write it back afterwards.
    func forget() {
        draft = ""
        draftAttachments = []
        outbox = []
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
