import Foundation
import Observation
import SupervisorChannelsKit

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
// What a queued message carries besides its text (SupervisorChannelsKit's
// QueuedTurnQueue holds the order, edit and Send Now state).
struct ChatQueuedPayload: Equatable, Sendable {
    var attachments: [ChatAttachment]
    var focusedCardID: String?
}

typealias QueuedChatSubmission = QueuedTurn<ChatQueuedPayload>

extension QueuedTurn where Payload == ChatQueuedPayload {
    var attachments: [ChatAttachment] { payload.attachments }
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
    // Messages sent while a reply was running. Sent one at a time, in order;
    // see QueuedTurnQueue for Edit, Remove and Send Now.
    private(set) var queue = QueuedTurnQueue<ChatQueuedPayload>()
    var queuedSubmissions: [QueuedChatSubmission] { queue.items }
    var editingQueuedID: UUID? { queue.editingID }
    // The open queued-message editor's text. Saving never sends.
    var queuedEditDraft = ""
    // The hub keeps this conversation's queue (its history answered with
    // one): the tray then mirrors it -- every device's waiting messages, in
    // the hub's order -- and Edit, Remove and Send Now are hub requests. A
    // hub without one leaves the queue on this phone, as before.
    private(set) var hubQueueAvailable = false
    // The message the hub runs now, when it came through the queue.
    private(set) var hubRunning: HubQueueItem?
    var isBusy: Bool { isSending || !queue.isEmpty || hubRunning != nil }
    private var uploadTask: Task<Void, Never>?
    private var holdRenewal: Task<Void, Never>?
    // The hub revision the open editor started from. Save sends this, never a
    // newer one a refresh brought meanwhile, so a stale draft is refused
    // (conflict) instead of silently replacing another device's edit.
    private var editBaseRevision: Int?
    // The message whose upload is on the wire now, and messages removed here
    // while that was so: the hub may have taken them, so they are removed on
    // the hub too once the upload settles (and never shown again meanwhile).
    private var uploadingRequestID: String?
    private var removeAfterUpload: Set<String> = []
    // Where the "while a reply is running" preference (Settings) is kept.
    private let preferences: UserDefaults
    var busySendBehavior: BusySendBehavior { BusySendBehavior.stored(in: preferences) }
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
    // The reply whose `/message` stream is open now, and how to close it.
    private var openStream: (replyID: UUID, close: @Sendable () -> Void)?
    // The reply streaming now and its turn id (nil when main can't know it),
    // the one Send Now interrupts.
    private var runningReply: (replyID: UUID, requestID: String?)?
    // Between `enterBackground` and the next `resume`.
    private var isAway = false

    init(thread: ConversationThread, client: DaemonClient, store: ChatHistoryStore, nodeID: String,
         conversationID: String = "main", isReadOnly: Bool = false, preferences: UserDefaults = .standard) {
        self.preferences = preferences
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

    // MARK: - Queued messages

    private func isOnHub(_ item: QueuedChatSubmission?) -> Bool {
        hubQueueAvailable && item != nil && item?.origin?.pendingUpload != true
    }

    func removeQueuedSubmission(id: UUID) {
        guard let item = queue.item(id) else { return }
        if hubQueueAvailable, item.requestID == uploadingRequestID {
            removeAfterUpload.insert(item.requestID)
            queue.remove(id)
            if queue.editingID == nil { queuedEditDraft = "" }
            return
        }
        if isOnHub(item) {
            // Removed here at once; the hub's answer (or a refresh) is final.
            let revision = item.origin?.revision
            queue.remove(id)
            if queue.editingID == nil { queuedEditDraft = "" }
            Task {
                do {
                    applyHubQueue(try await client.removeQueued(thread: thread, requestId: item.requestID, baseRevision: revision, conversationId: conversationID))
                } catch {
                    await refresh()
                    noteQueueError(item.requestID, error, fallback: "Couldn't reach main, so it is still queued.")
                }
            }
            return
        }
        guard queue.remove(id) != nil else { return }
        if queue.editingID == nil { queuedEditDraft = "" }
        drainIfIdle()
    }

    // Opens the inline editor. The queue waits at this message (it never
    // sends the old text, and nothing after it jumps ahead) until Save or
    // Cancel. On a hub queue the message is held there for this phone, so
    // no device runs or changes it meanwhile.
    @discardableResult
    func beginEditingQueued(id: UUID) -> Bool {
        // Not while its upload is on the wire: the hub may already run it.
        guard !isReadOnly, let item = queue.item(id), item.origin?.heldBy == nil, item.requestID != uploadingRequestID,
              let text = queue.beginEditing(id) else { return false }
        queue.setOrigin(id) { $0.error = nil }
        queuedEditDraft = text
        editBaseRevision = item.origin?.revision
        if isOnHub(item) { holdWhileEditing(item) }
        return true
    }

    // Holds the item on the hub and renews the hold while the editor is
    // open. Refused (another device is editing it, or it already ran): the
    // editor closes and the row says why.
    private func holdWhileEditing(_ item: QueuedChatSubmission) {
        holdRenewal?.cancel()
        holdRenewal = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.queue.editingID == item.id else { return }
                do {
                    self.applyHubQueue(try await self.client.updateQueued(thread: self.thread, requestId: item.requestID, hold: true, conversationId: self.conversationID))
                } catch let refused as HubQueueRefused {
                    if self.queue.editingID == item.id {
                        self.queue.cancelEdit()
                        self.queuedEditDraft = ""
                    }
                    self.queue.setOrigin(item.id) { $0.error = refused.displayMessage }
                    return
                } catch {
                    // Offline: keep editing here; Save says if it can't reach main.
                }
                try? await Task.sleep(for: .seconds(45))
            }
        }
    }

    // Saves in place: same position, same turn id. Never sends by itself;
    // the queue continues only if nothing is running.
    @discardableResult
    func saveQueuedEdit() -> Bool {
        guard let id = queue.editingID, let item = queue.item(id) else { return false }
        var text = queuedEditDraft
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !item.attachments.isEmpty {
            text = "Please describe the attached images."
        }
        let onHub = isOnHub(item)
        let revision = editBaseRevision ?? item.origin?.revision
        guard queue.saveEdit(id, text: text) else { return false }
        queuedEditDraft = ""
        editBaseRevision = nil
        holdRenewal?.cancel()
        if onHub {
            let saved = queue.item(id)?.text ?? text
            Task {
                do {
                    applyHubQueue(try await client.updateQueued(thread: thread, requestId: item.requestID, text: saved, hold: false,
                                                                baseRevision: revision, conversationId: conversationID))
                } catch {
                    // Not saved: show what main has, and why.
                    await refresh()
                    noteQueueError(item.requestID, error, fallback: "Couldn't reach main, so your edit wasn't saved.")
                }
            }
        } else if item.origin?.pendingUpload == true {
            queue.setOrigin(id) { $0.error = nil }
            uploadPending()
        } else {
            drainIfIdle()
        }
        return true
    }

    func cancelQueuedEdit() {
        let item = queue.editingID.flatMap { queue.item($0) }
        queue.cancelEdit()
        queuedEditDraft = ""
        editBaseRevision = nil
        holdRenewal?.cancel()
        if isOnHub(item), let item {
            Task { applyHubQueue(try? await client.updateQueued(thread: thread, requestId: item.requestID, hold: false, conversationId: conversationID)) }
        }
        // A message not yet on the hub waited for its editor; deliver it now.
        if hubQueueAvailable { uploadPending() }
        drainIfIdle()
    }

    func canSendQueuedNow(id: UUID) -> Bool {
        guard !isReadOnly, !forgotten, let item = queue.item(id) else { return false }
        if hubQueueAvailable && (item.origin?.pendingUpload == true || item.origin?.heldBy != nil) { return false }
        return queue.canSendNow(id)
    }

    // "Send now": the message moves to the front and main is asked to stop
    // the running reply. It goes next whatever main answers; its row says
    // what main confirmed. Repeated taps while that is settling do nothing.
    // On a hub queue the hub moves it and stops whatever runs now, whichever
    // device sent that.
    func sendQueuedNow(id: UUID) async {
        guard !isReadOnly, !forgotten else { return }
        if let item = queue.item(id), isOnHub(item) {
            guard canSendQueuedNow(id: id), queue.beginHubSendNow(id) else { return }
            do {
                let (outcome, snapshot) = try await client.sendQueuedNow(thread: thread, requestId: item.requestID, conversationId: conversationID)
                queue.applyInterrupt(id, outcome: outcome)
                applyHubQueue(snapshot)
            } catch let refused as HubQueueRefused {
                queue.clearSendNow(id)
                queue.setOrigin(id) { $0.error = refused.displayMessage }
                await refresh()
            } catch {
                queue.applyInterrupt(id, outcome: .unreachable)
            }
            return
        }
        let target = interruptTarget
        switch queue.beginSendNow(id, replyRunning: target.running, runningRequestID: target.requestID) {
        case .ignored, .cannotInterrupt:
            return
        case .sendNext:
            drainIfIdle()
        case .interrupt(let requestID):
            let outcome = await client.interruptTurn(thread: thread, requestId: requestID, conversationId: conversationID)
            queue.applyInterrupt(id, outcome: outcome)
            drainIfIdle()
        }
    }

    // The reply main is actually running. A reply whose stream was lost while
    // main kept working (detached) runs ahead of anything sent after it, so
    // it is the one to stop -- not a later message waiting behind it on main.
    // Otherwise, the reply streaming now.
    var interruptTarget: (running: Bool, requestID: String?) {
        if let detached = messages.first(where: { $0.role == .assistant && $0.isDetached && $0.requestID != nil }) {
            return (true, detached.requestID)
        }
        if let running = runningReply { return (true, running.requestID) }
        return (false, nil)
    }

    // The hub's queue, as the newest history page or a queue request
    // returned it. nil (an older hub) leaves the phone's own queue alone.
    private func applyHubQueue(_ snapshot: HubQueueSnapshot?) {
        mirrorHub(snapshot)
        uploadPending()
        startRecoveryIfNeeded()
    }

    private func mirrorHub(_ snapshot: HubQueueSnapshot?) {
        guard let snapshot, !forgotten else { return }
        // Older than what is shown (a slow refresh crossed a newer change).
        if let shown = queue.hubRevision, snapshot.revision < shown { return }
        if !hubQueueAvailable {
            // Anything queued here before the hub was known goes to the hub.
            for item in queue.items where item.origin == nil {
                queue.setOrigin(item.id) { $0.pendingUpload = true; $0.mine = true }
            }
            hubQueueAvailable = true
        }
        hubRunning = snapshot.running
        // Every waiting message keeps its controls here, including one this
        // phone sent on a stream that the hub queued behind another turn.
        queue.mirror(snapshot, payload: { _ in ChatQueuedPayload(attachments: [], focusedCardID: nil) }, skip: removeAfterUpload)
        settleEnded(snapshot.ended ?? [])
    }

    // A reply whose stream was lost while its message waited on the hub, and
    // the message then left the queue without running (removed on another
    // device, stopped first): say so instead of "still working".
    private func settleEnded(_ ended: [HubQueueEnded]) {
        var changed = false
        for entry in ended {
            guard let index = messages.firstIndex(where: { $0.role == .assistant && $0.isDetached && $0.requestID == entry.requestId }) else { continue }
            messages[index].isDetached = false
            messages[index].isStreaming = false
            messages[index].activity = nil
            messages[index].text = entry.outcome == "stopped" ? Self.stoppedText
                : entry.outcome == "removed" ? Self.removedText
                : (entry.message ?? "This message was not run.")
            changed = true
        }
        if changed { persist() }
    }

    static let removedText = "Removed from the queue before it ran. Nothing was sent to the agent."

    #if DEBUG
    // Tests: a reply whose stream was lost after main accepted it.
    func markDetachedForTesting(requestID: String) {
        guard let index = messages.firstIndex(where: { $0.role == .assistant && $0.requestID == requestID }) else { return }
        messages[index].isDetached = true
        messages[index].isStreaming = true
        messages[index].activity = ChatHistoryCodec.stillWorking
    }
    #endif

    private func noteQueueError(_ requestID: String, _ error: Error, fallback: String) {
        guard let item = queue.item(requestID: requestID) else { return }
        let text = (error as? HubQueueRefused)?.displayMessage ?? fallback
        queue.setOrigin(item.id) { $0.error = text }
    }

    // Sends messages the hub has not accepted yet, oldest first, each with
    // its own turn id: a resend after a lost answer is the same message, so
    // the hub keeps one. Offline, they wait here for the next refresh.
    private func uploadPending() {
        guard hubQueueAvailable, uploadTask == nil, !forgotten else { return }
        uploadTask = Task { [weak self] in
            await self?.removeAfterUploads()
            while let self, !self.forgotten,
                  let next = self.queue.nextUpload {
                self.uploadingRequestID = next.requestID
                var offline = false
                do {
                    let (snapshot, interrupt) = try await self.client.enqueueMessage(
                        thread: self.thread, text: next.text, attachments: next.attachments,
                        focusedCardId: next.payload.focusedCardID, requestId: next.requestID,
                        conversationId: self.conversationID, next: next.origin?.sendNext == true)
                    self.queue.setOrigin(next.id) { $0.pendingUpload = false; $0.revision = max($0.revision, 1) }
                    if next.origin?.sendNext == true {
                        // What the hub confirmed; it ran at once when nothing was running.
                        self.queue.setSendNowOutcome(next.id, interrupt ?? .nothingRunning)
                    }
                    self.uploadingRequestID = nil
                    self.mirrorHub(snapshot)
                } catch let refused as HubQueueRefused where refused.code == "queue_full" {
                    // Full for now, not refused: it stays next to deliver and
                    // is tried again on the next refresh (nothing passes it).
                    offline = true
                } catch let refused as HubQueueRefused {
                    self.queue.setOrigin(next.id) { $0.error = refused.displayMessage }
                } catch {
                    offline = true
                    // Not stopped: main was not reached. It is tried again.
                    if next.origin?.sendNext == true { self.queue.setSendNowOutcome(next.id, .unreachable) }
                }
                self.uploadingRequestID = nil
                await self.removeAfterUploads()
                if offline { break }
            }
            self?.uploadTask = nil
        }
    }

    // Removals made while their upload was on the wire: the hub may have the
    // message, so remove it there too. Offline, they wait for the next try.
    private func removeAfterUploads() async {
        for requestID in removeAfterUpload {
            do {
                mirrorHub(try await client.removeQueued(thread: thread, requestId: requestID, baseRevision: nil, conversationId: conversationID))
                removeAfterUpload.remove(requestID)
            } catch is HubQueueRefused {
                // Never reached the hub, or already ran: nothing left to remove.
                removeAfterUpload.remove(requestID)
            } catch {
                return
            }
        }
    }

    // Starts sending the queue when nothing is running: after an edit
    // closes, a removal, or a retry ends. A hub queue runs on the hub.
    private func drainIfIdle() {
        guard !hubQueueAvailable, !isSending, !forgotten, !isReadOnly, !queue.isEmpty, !queue.isWaitingOnEdit else { return }
        isSending = true
        Task {
            defer { isSending = false }
            await drainQueue()
        }
    }

    private func drainQueue() async {
        while !hubQueueAvailable, !forgotten, let next = queue.takeNext() {
            appendTurn(text: next.text, attachments: next.attachments, requestID: next.requestID)
            await streamReply(text: next.text, attachments: next.attachments, replyID: messages[messages.count - 1].id,
                              focusedCardID: next.payload.focusedCardID)
        }
    }

    // Reserve the turn and reset the native editor in the same main-actor
    // transaction. Return-key and Send cannot race two unstructured tasks.
    //
    // Idle, it sends. While a reply runs (here or on the hub, or messages
    // still wait), the Settings preference decides -- Queue message (default)
    // or Send immediately -- and `override` is the composer's one-message
    // choice the other way ("Send anyway" / "Queue instead").
    @discardableResult
    func submitDraft(override: BusySendBehavior? = nil) -> Bool {
        guard canSubmitDraft else { return false }
        let text = draft
        let attachments = draftAttachments
        let decision = SendDecision.resolve(busy: isBusy, preference: busySendBehavior, override: override)
        if decision == .sendNext {
            guard !forgotten else { return false }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let effective = trimmed.isEmpty ? "Please describe the attached images." : trimmed
            draft = ""
            draftAttachments = []
            composerRevision += 1
            let id = queue.enqueue(text: effective, payload: ChatQueuedPayload(attachments: attachments, focusedCardID: focusedCardID),
                                   requestID: Self.newRequestID(),
                                   origin: hubQueueAvailable ? QueuedOrigin(mine: true, pendingUpload: true, sendNext: true) : nil)
            if hubQueueAvailable {
                // Shown first at once, asking; the hub's answer says what happened.
                queue.beginHubSendNow(id)
                uploadPending()
            } else {
                // Main keeps no queue: this phone's queue, front, then stop
                // the running reply (or say plainly that it can't be).
                Task { await sendQueuedNow(id: id) }
            }
            return true
        }
        // Busy, or messages are still waiting (one is being edited), here or
        // on the hub: this one goes after them, never ahead.
        if decision == .queue {
            guard !forgotten else { return false }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let effective = trimmed.isEmpty ? "Please describe the attached images." : trimmed
            draft = ""
            draftAttachments = []
            composerRevision += 1
            queue.enqueue(text: effective, payload: ChatQueuedPayload(attachments: attachments, focusedCardID: focusedCardID),
                          requestID: Self.newRequestID(),
                          origin: hubQueueAvailable ? QueuedOrigin(mine: true, pendingUpload: true) : nil)
            if hubQueueAvailable { uploadPending() } else { drainIfIdle() }
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

    // The user line and its reply placeholder, both named with the turn id
    // (a queued message keeps the one it was given when queued).
    private func appendTurn(text: String, attachments: [ChatAttachment], requestID: String = ChatConversation.newRequestID()) {
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
        await drainQueue()
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
        await drainQueue()
    }

    func requestComposerFocus() {
        composerFocusRequest += 1
    }

    private func streamReply(text: String, attachments: [ChatAttachment], replyID: UUID, focusedCardID: String? = nil) async {
        var sawTerminalFrame = false
        var openedStream = false
        let requestID = messages.first(where: { $0.id == replyID })?.requestID
        // Set before any await, so a Send Now tap always sees this reply.
        // (A main that rejected turn ids answers an interrupt `.unsupported`.)
        runningReply = (replyID, requestID)
        defer { if runningReply?.replyID == replyID { runningReply = nil } }
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
            // Relayed so `enterBackground` can end this loop: a socket iOS
            // cut while the phone was locked may never report an error.
            let (events, relay) = AsyncThrowingStream<ChatEvent, Error>.makeStream()
            let pump = Task {
                do {
                    for try await event in stream { relay.yield(event) }
                    relay.finish()
                } catch {
                    relay.finish(throwing: error)
                }
            }
            relay.onTermination = { _ in pump.cancel() }
            openStream = (replyID, { relay.finish() })
            defer { if openStream?.replyID == replyID { openStream = nil } }
            for try await event in events {
                guard let index = messages.firstIndex(where: { $0.id == replyID }) else { continue }
                switch event {
                case .delta(let frame):
                    // Text means main is running the turn, whatever frames
                    // came before it.
                    messages[index].accepted = true
                    // Accepted after the app left: let go now, as
                    // enterBackground does, rather than suspend on it.
                    if isAway { relay.finish() }
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
                    if frame.code == "stopped" {
                        // Send Now stopped it: not a fault, nothing to retry.
                        stopped(replyID)
                    } else if frame.code == "removed" {
                        // Taken out of the hub's queue (here or on another device).
                        messages[index].text = Self.removedText
                        messages[index].isStreaming = false
                        messages[index].activity = nil
                    } else {
                        fail(replyID, text: (frame.error ?? "OpenAGI couldn't finish.") + " Check the conversation before sending again.")
                    }
                case .status(let frame):
                    if messages[index].isStreaming, let label = frame.activityLabel {
                        messages[index].activity = label
                    }
                case .session:
                    // Main has the turn: from here on it is never lost.
                    messages[index].accepted = true
                    grace.end()
                    persist()
                    if isAway { relay.finish() }
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
        // Away, nothing polls: `resume` catches up on return.
        guard !isAway else { return }
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
        isAway = false
        await refresh()
        startRecoveryIfNeeded()
        if historyStatus == .synced, !isSending,
           let pending = messages.first(where: { $0.isFailed && $0.autoRetry && $0.retrySafe }) {
            if let index = messages.firstIndex(where: { $0.id == pending.id }) {
                messages[index].autoRetry = false
            }
            await retry(pending)
        }
        drainIfIdle()
    }

    // Stops polling when the app leaves the foreground; `resume` restarts it.
    func pauseRecovery() {
        recoveryTask?.cancel()
        recoveryTask = nil
    }

    // The app went to the background (locked, or another app). iOS suspends
    // it within seconds, and a stream it cut can look open on return, so
    // a reply main has accepted leaves the stream now and is found again in
    // history on `resume`. A send main has not confirmed keeps its stream:
    // the background grace period exists to finish handing it over.
    func enterBackground() {
        isAway = true
        pauseRecovery()
        guard let open = openStream,
              messages.first(where: { $0.id == open.replyID })?.accepted == true else { return }
        open.close()
    }

    // Detached replies to find again, or hub-queued work still waiting or
    // running (in case /events is down): keep checking while active.
    private var needsPolling: Bool {
        messages.contains(where: \.isDetached) || (hubQueueAvailable && (!queue.isEmpty || hubRunning != nil || !removeAfterUpload.isEmpty))
    }

    private func startRecoveryIfNeeded() {
        guard recoveryTask == nil, !forgotten, !isAway, needsPolling else { return }
        let token = UUID()
        recoveryToken = token
        recoveryTask = Task { [weak self] in
            var delay: UInt64 = 2
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                // Re-check after waking: the reply may have arrived meanwhile
                // (another refresh, an /events update), or the chat was closed.
                guard let self, !Task.isCancelled, !self.forgotten, self.needsPolling else { break }
                await self.refresh()
                delay = min(delay * 2, 15)
            }
            if self?.recoveryToken == token { self?.recoveryTask = nil }
        }
    }

    static let stoppedText = "Stopped so your next message could go first. Anything already under way may have finished; nothing was undone."

    // A reply stopped by Send Now keeps what had streamed so far.
    private func stopped(_ replyID: UUID) {
        guard let index = messages.firstIndex(where: { $0.id == replyID }) else { return }
        let partial = messages[index].text.trimmingCharacters(in: .whitespacesAndNewlines)
        messages[index].text = partial.isEmpty ? Self.stoppedText : partial + "\n\n" + Self.stoppedText
        messages[index].isStreaming = false
        messages[index].activity = nil
        messages[index].isFailed = false
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
            let (page, hubQueue) = try await client.conversationPageWithQueue(thread: thread, conversationId: conversationID)
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
            applyHubQueue(hubQueue)
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
        uploadTask?.cancel()
        holdRenewal?.cancel()
        forgotten = true
    }

    // On revoke: the cache belongs to the pairing being forgotten, and a
    // reply still streaming must not write it back afterwards.
    func forget() {
        uploadTask?.cancel()
        holdRenewal?.cancel()
        hubRunning = nil
        draft = ""
        draftAttachments = []
        queue.removeAll()
        queuedEditDraft = ""
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
