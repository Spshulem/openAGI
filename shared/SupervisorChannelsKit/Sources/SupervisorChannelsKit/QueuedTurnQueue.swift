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
        default: return .unreachable
        }
    }

    /// The reply is stopped or will stop, or already ended: this item goes next
    /// and a second Send Now has nothing left to do.
    public var settlesNext: Bool {
        switch self {
        case .interrupted, .stopping, .finished: return true
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

public struct QueuedTurn<Payload: Equatable>: Identifiable, Equatable {
    public let id: UUID
    public var text: String
    public var payload: Payload
    /// The turn id main will know this message by once sent. Fixed at
    /// queue time, so a resend of the same item can never run twice.
    public let requestID: String
    public var sendNow: QueuedSendNowState?

    public init(id: UUID = UUID(), text: String, payload: Payload, requestID: String, sendNow: QueuedSendNowState? = nil) {
        self.id = id
        self.text = text
        self.payload = payload
        self.requestID = requestID
        self.sendNow = sendNow
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
    public mutating func enqueue(text: String, payload: Payload, requestID: String, id: UUID = UUID()) -> UUID {
        items.append(QueuedTurn(id: id, text: text, payload: payload, requestID: requestID))
        return id
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
    }
}
