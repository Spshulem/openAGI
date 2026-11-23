import Foundation

// Messages the owner typed while a reply was still running, shared by the
// iPhone chat and the Mac Supervisor chat so both behave the same way.
//
// - Send while busy queues; the queue sends one at a time, in order.
// - Edit changes an item in place. While it is open, the queue waits at it
//   instead of sending the old text or skipping ahead. Saving never sends.
// - Remove drops one item; the others keep their order.
// - Send Now moves one item to the front and asks main to interrupt the
//   running reply (POST /conversations/:thread/interrupt). The item then goes
//   next, whatever main answers; its status says what actually happened. A
//   tool that was already running is never undone, and the status never
//   claims an interrupt main did not confirm.

/// What main said when asked to stop the running reply.
public enum TurnInterruptOutcome: Equatable, Sendable {
    /// The reply stopped. Nothing more of it runs.
    case interrupted
    /// Main is stopping it, after the action running now (a tool) finishes.
    case stopping(tool: String?)
    /// It had already ended on its own. Nothing was interrupted.
    case finished
    /// Nothing was running, so nothing needed stopping; it goes next.
    case nothingRunning
    /// Main has no running reply by that id (it may not have reached main).
    case notFound
    /// This main is too old to interrupt replies.
    case unsupported
    /// The request got no answer (offline, timeout). Unknown whether it stopped.
    case unreachable

    /// Decodes the `status` main returns.
    public static func fromServer(status: String?, tool: String?) -> TurnInterruptOutcome {
        switch status {
        case "interrupted": return .interrupted
        case "stopping": return .stopping(tool: tool)
        case "finished": return .finished
        case "not_found": return .notFound
        case "next": return .nothingRunning
        default: return .unreachable
        }
    }

    /// The reply is stopped or will stop, or already ended: this item goes next
    /// and a second Send Now has nothing left to do.
    public var settlesNext: Bool {
        switch self {
        case .interrupted, .stopping, .finished, .nothingRunning: return true
        case .notFound, .unsupported, .unreachable: return false
        }
    }

    public var isError: Bool { !settlesNext }
}

public enum QueuedSendNowState: Equatable, Sendable {
    /// Asking main to stop the running reply.
    case requesting
    case answered(TurnInterruptOutcome)

    /// Plain words for the queued row. Never claims more than main confirmed.
    public var label: String {
        switch self {
        case .requesting:
            return "Stopping the current reply…"
        case .answered(.interrupted):
            return "Reply stopped. This sends next."
        case .answered(.stopping(let tool)):
            let action = tool.map { "“" + $0.replacingOccurrences(of: "_", with: " ") + "”" } ?? "the current action"
            return "Stopping after \(action) finishes; it won't be undone. This sends next."
        case .answered(.finished):
            return "The reply had already finished. This sends next."
        case .answered(.nothingRunning):
            return "Nothing was running. This sends next."
        case .answered(.notFound):
            return "Couldn't stop the reply: main doesn't see it running. This sends when it ends."
        case .answered(.unsupported):
            return "This main can't interrupt replies yet. Update OpenAGI on main. This sends when the reply ends."
        case .answered(.unreachable):
            return "Couldn't reach main to stop the reply. This sends when it ends. Try again?"
        }
    }

    public var isError: Bool {
        if case .answered(let outcome) = self { return outcome.isError }
        return false
    }

    /// Send Now can be pressed again: the last attempt did not settle it.
    public var allowsRetry: Bool {
        if case .answered(let outcome) = self { return !outcome.settlesNext }
        return false
    }
}

/// Where a queued message lives when the hub keeps the queue (see
/// HubQueueSnapshot): who sent it, whether this device did, who is editing
/// it, and the revision an edit must name.
public struct QueuedOrigin: Equatable, Sendable {
    public var sourceName: String?
    public var mine: Bool
    public var heldBy: String?
    public var revision: Int
    /// Not yet accepted by the hub (offline, or the request failed): kept
    /// here and sent again with the same turn id.
    public var pendingUpload: Bool
    /// The last hub refusal for this item, shown on its row.
    public var error: String?
    /// Sent with "Send anyway": when the hub takes it, it goes next and the
    /// running reply is stopped (one request, so a retry does it once).
    public var sendNext: Bool

    public init(sourceName: String? = nil, mine: Bool = true, heldBy: String? = nil, revision: Int = 0, pendingUpload: Bool = false,
                error: String? = nil, sendNext: Bool = false) {
        self.sourceName = sourceName
        self.mine = mine
        self.heldBy = heldBy
        self.revision = revision
        self.pendingUpload = pendingUpload
        self.error = error
        self.sendNext = sendNext
    }
}

public struct QueuedTurn<Payload: Equatable>: Identifiable, Equatable {
    public let id: UUID
    public var text: String
    public var payload: Payload
    /// The turn id main will know this message by once sent. Fixed at
    /// queue time, so a resend of the same item can never run twice.
    public let requestID: String
    public var sendNow: QueuedSendNowState?
    /// Set when the hub keeps the queue; nil for a queue only this device has.
    public var origin: QueuedOrigin?

    public init(id: UUID = UUID(), text: String, payload: Payload, requestID: String, sendNow: QueuedSendNowState? = nil, origin: QueuedOrigin? = nil) {
        self.id = id
        self.text = text
        self.payload = payload
        self.requestID = requestID
        self.sendNow = sendNow
        self.origin = origin
    }
}

extension QueuedTurn: Sendable where Payload: Sendable {}

public enum QueuedSendNowPlan: Equatable, Sendable {
    /// Moved to the front; ask main to interrupt this reply.
    case interrupt(requestID: String)
    /// Moved to the front; nothing is running to interrupt, so it simply
    /// goes next.
    case sendNext
    /// Moved to the front, but the running reply has no turn id main knows
    /// (an older main), so it cannot be interrupted. Marked unsupported.
    case cannotInterrupt
    /// Not allowed now (being edited, already going next, or gone).
    case ignored
}

public struct QueuedTurnQueue<Payload: Equatable>: Equatable {
    public private(set) var items: [QueuedTurn<Payload>] = []
    /// The item whose editor is open. The queue never sends it, or anything
    /// after it, until the edit is saved or cancelled.
    public private(set) var editingID: UUID?
    /// The next message to deliver to the hub: the first one it has not
    /// accepted, unless that one's editor is open (then nothing: later ones
    /// never pass it, and the old text is never sent mid-edit).
    public var nextUpload: QueuedTurn<Payload>? {
        guard let next = items.first(where: { $0.origin?.pendingUpload == true && $0.origin?.error == nil }) else { return nil }
        return next.id == editingID ? nil : next
    }

    /// The newest hub revision mirrored. An older snapshot (a slow refresh
    /// that crossed a newer change) is ignored rather than undoing it.
    public private(set) var hubRevision: Int?

    public init() {}

    public var isEmpty: Bool { items.isEmpty }
    public var count: Int { items.count }

    /// True while an item already holds the next slot because of Send Now:
    /// a second Send Now (a double tap, or on another item) waits for it.
    public var hasSettledSendNow: Bool {
        items.contains { item in
            switch item.sendNow {
            case .requesting: return true
            case .answered(let outcome): return outcome.settlesNext
            case nil: return false
            }
        }
    }

    @discardableResult
    public mutating func enqueue(text: String, payload: Payload, requestID: String, id: UUID = UUID(), origin: QueuedOrigin? = nil) -> UUID {
        items.append(QueuedTurn(id: id, text: text, payload: payload, requestID: requestID, origin: origin))
        return id
    }

    public func item(requestID: String) -> QueuedTurn<Payload>? { items.first { $0.requestID == requestID } }

    public mutating func setOrigin(_ id: UUID, _ change: (inout QueuedOrigin) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        var origin = items[index].origin ?? QueuedOrigin()
        change(&origin)
        items[index].origin = origin
    }

    /// Replaces the queue with the hub's (waiting items only, in its order),
    /// keeping what only this device knows: the open editor, a Send Now
    /// status, and messages the hub has not accepted yet (kept last, in
    /// order). `skip` names turn ids already shown as sent in this chat.
    public mutating func mirror(_ snapshot: HubQueueSnapshot, payload: (HubQueueItem) -> Payload, skip: Set<String> = []) {
        if let hubRevision, snapshot.revision < hubRevision { return }
        hubRevision = snapshot.revision
        let previous = Dictionary(items.map { ($0.requestID, $0) }, uniquingKeysWith: { first, _ in first })
        let hubIDs = Set(snapshot.items.map(\.requestId))
        var next: [QueuedTurn<Payload>] = []
        for hubItem in snapshot.items where hubItem.state != "running" && !skip.contains(hubItem.requestId) {
            let known = previous[hubItem.requestId]
            let origin = QueuedOrigin(sourceName: hubItem.source?.name, mine: hubItem.mine ?? false,
                                      heldBy: hubItem.state == "held" && hubItem.heldByMe != true ? hubItem.heldBy : nil, revision: hubItem.revision,
                                      pendingUpload: false, error: known?.origin?.error)
            next.append(QueuedTurn(id: known?.id ?? UUID(), text: hubItem.text, payload: known?.payload ?? payload(hubItem),
                                   requestID: hubItem.requestId, sendNow: known?.sendNow, origin: origin))
        }
        // Not on the hub yet: this device's own, still to be sent.
        for item in items where item.origin?.pendingUpload == true && !hubIDs.contains(item.requestID) && !skip.contains(item.requestID) {
            next.append(item)
        }
        items = next
        if let editingID, !items.contains(where: { $0.id == editingID }) { self.editingID = nil }
    }

    public func item(_ id: UUID) -> QueuedTurn<Payload>? { items.first { $0.id == id } }

    @discardableResult
    public mutating func remove(_ id: UUID) -> QueuedTurn<Payload>? {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        if editingID == id { editingID = nil }
        return items.remove(at: index)
    }

    /// Opens the editor on one item. Returns its current text, or nil when
    /// the item is gone or another edit is open.
    public mutating func beginEditing(_ id: UUID) -> String? {
        guard let item = item(id), editingID == nil || editingID == id else { return nil }
        editingID = id
        return item.text
    }

    /// Saves the edit in place: same position, same turn id. Never sends.
    /// A blank edit is refused (use Remove); the editor stays open.
    @discardableResult
    public mutating func saveEdit(_ id: UUID, text: String, payload: Payload? = nil, allowBlank: Bool = false) -> Bool {
        guard editingID == id, let index = items.firstIndex(where: { $0.id == id }) else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || allowBlank else { return false }
        items[index].text = trimmed
        if let payload { items[index].payload = payload }
        editingID = nil
        return true
    }

    public mutating func cancelEdit() { editingID = nil }

    public func canSendNow(_ id: UUID) -> Bool {
        guard let item = item(id), editingID != id else { return false }
        if hasSettledSendNow { return false }
        return item.sendNow == nil || item.sendNow?.allowsRetry == true
    }

    /// Moves the item to the front (everything else keeps its order) and
    /// says whether to interrupt. `replyRunning` is whether a reply is
    /// streaming now; `runningRequestID` its turn id, when main knows one.
    public mutating func beginSendNow(_ id: UUID, replyRunning: Bool, runningRequestID: String?) -> QueuedSendNowPlan {
        guard canSendNow(id), let index = items.firstIndex(where: { $0.id == id }) else { return .ignored }
        var item = items.remove(at: index)
        // An earlier Send Now that did not settle no longer holds the front.
        for other in items.indices where items[other].sendNow != nil { items[other].sendNow = nil }
        guard replyRunning else {
            item.sendNow = nil
            items.insert(item, at: 0)
            return .sendNext
        }
        guard let runningRequestID, !runningRequestID.isEmpty else {
            item.sendNow = .answered(.unsupported)
            items.insert(item, at: 0)
            return .cannotInterrupt
        }
        item.sendNow = .requesting
        items.insert(item, at: 0)
        return .interrupt(requestID: runningRequestID)
    }

    /// Send Now when the hub keeps the queue: moved first here at once
    /// (the hub's answer reorders for real) and marked as asking.
    @discardableResult
    public mutating func beginHubSendNow(_ id: UUID) -> Bool {
        guard canSendNow(id), let index = items.firstIndex(where: { $0.id == id }) else { return false }
        var item = items.remove(at: index)
        for other in items.indices where items[other].sendNow != nil { items[other].sendNow = nil }
        item.sendNow = .requesting
        items.insert(item, at: 0)
        return true
    }

    /// What the hub said about a "Send anyway" message once it took it
    /// (after any earlier "couldn't reach main" for the same message).
    public mutating func setSendNowOutcome(_ id: UUID, _ outcome: TurnInterruptOutcome) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].sendNow = .answered(outcome)
    }

    /// The hub refused Send Now (held elsewhere, already sent): no status.
    public mutating func clearSendNow(_ id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].sendNow = nil
    }

    /// Records main's answer. A no-op when the item was removed or already
    /// sent while the request was out.
    public mutating func applyInterrupt(_ id: UUID, outcome: TurnInterruptOutcome) {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].sendNow == .requesting else { return }
        items[index].sendNow = .answered(outcome)
    }

    /// The next item to send, removed from the queue. Nil when the queue is
    /// empty or its front item is being edited (the queue waits there).
    public mutating func takeNext() -> QueuedTurn<Payload>? {
        guard let first = items.first, first.id != editingID else { return nil }
        return items.removeFirst()
    }

    /// The queue holds items but is waiting for an open edit.
    public var isWaitingOnEdit: Bool { items.first.map { $0.id == editingID } ?? false }

    public mutating func removeAll() {
        items = []
        editingID = nil
        hubRevision = nil
    }
}

// MARK: - The hub's queue on the wire (GET /conversations/:thread/queue, and
// `queue` in the newest history page).

public struct HubQueueItem: Codable, Equatable, Sendable, Identifiable {
    public struct Source: Codable, Equatable, Sendable {
        public let device: String?
        public let name: String?
        public let nodeId: String?
    }
    public let requestId: String
    public let text: String
    public let attachmentCount: Int?
    public let source: Source?
    public let mine: Bool?
    /// "running", "queued" or "held" (being edited on some device).
    public let state: String
    public let heldBy: String?
    /// True when this device holds the edit (its own open editor).
    public let heldByMe: Bool?
    public let position: Int?
    public let revision: Int
    public var id: String { requestId }

    public init(requestId: String, text: String, attachmentCount: Int? = nil, source: Source? = nil, mine: Bool? = nil,
                state: String, heldBy: String? = nil, heldByMe: Bool? = nil, position: Int? = nil, revision: Int) {
        self.requestId = requestId
        self.text = text
        self.attachmentCount = attachmentCount
        self.source = source
        self.mine = mine
        self.state = state
        self.heldBy = heldBy
        self.heldByMe = heldByMe
        self.position = position
        self.revision = revision
    }
}

public struct HubQueueSnapshot: Codable, Equatable, Sendable {
    public let revision: Int
    public let items: [HubQueueItem]
    public init(revision: Int, items: [HubQueueItem]) {
        self.revision = revision
        self.items = items
    }
    /// The message the hub is running now, if it came through the queue.
    public var running: HubQueueItem? { items.first { $0.state == "running" } }
}

/// Plain words for a hub refusal of an edit, removal or Send Now.
public enum HubQueueRefusal {
    public static func message(code: String?, fallback: String?) -> String {
        switch code {
        case "held": return fallback ?? "Someone else is editing this message."
        case "conflict": return "This message changed on another device. Review it and try again."
        case "already_sent": return "This message was already sent, so it can't be changed."
        case "already_removed": return "This message was already removed."
        case "queue_full": return "The queue is full. Wait for some messages to send."
        default: return fallback ?? "Couldn't update the queue. Try again."
        }
    }
}
