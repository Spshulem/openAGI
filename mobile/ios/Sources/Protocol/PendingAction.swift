import Foundation

// `GET /pending-actions` -- mobile/PROTOCOL.md §6, verified live against the
// daemon. The detail view shows `args` and `reason` so a person is approving
// something they have actually read, per mobile/FEATURES.md's Inbox section.
public struct PendingAction: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let toolName: String
    public let args: JSONValue?
    public let context: JSONValue?
    public let summary: String
    public let reason: String?
    public let dedupeKey: String?
    public let status: String
    public let createdAt: Date
    // When the agent last asked for this card. A repeated request reuses the
    // pending card, so this moves while createdAt keeps its age. Absent from
    // mains older than the field.
    public let raisedAt: Date?
    public let expiresAt: Date?
    public let decidedAt: Date?
    public let decidedBy: String?
    public let result: JSONValue?
    public let error: String?
}

extension PendingAction {
    // The daemon records the turn's session in `context.sessionId`; phone
    // chats run as `devices:<thread>:<conversationId>` (shared-conversations.js).
    // When the agent last asked for it (`createdAt` on mains without raisedAt).
    public var lastRaisedAt: Date { raisedAt ?? createdAt }

    public var sessionID: String? {
        if case .object(let fields) = context, case .string(let id) = fields["sessionId"] { return id }
        return nil
    }

    // `/pending-actions` is daemon-wide: keep only the approvals this
    // conversation raised since `since`, before limiting, so other chats'
    // requests can neither appear here nor displace this turn's own.
    public static func raised(in actions: [PendingAction], thread: ConversationThread, conversationID: String,
                              since: Date, scopedToSession: Bool = true, limit: Int = 3) -> [PendingAction] {
        let session = "devices:\(thread.rawValue):\(conversationID)"
        // Newest request first: a card asked for again outranks its creation date.
        return Array(actions
            .filter { (!scopedToSession || $0.sessionID == session) && $0.lastRaisedAt >= since.addingTimeInterval(-5) }
            .sorted { $0.lastRaisedAt > $1.lastRaisedAt }
            .prefix(limit))
    }
}

public struct PendingActionsResponse: Codable, Sendable {
    public let actions: [PendingAction]
}

// `POST /pending-actions/:id/approve` re-invokes the underlying tool and
// returns that tool's own envelope -- `{"ok": true, "result": ...}` or
// `{"ok": false, "error": "..."}` -- with no single fixed schema beyond
// `ok`/`error` (mobile/PROTOCOL.md §6). `result`/`continuation` are decoded
// as loose JSON since their shape varies by tool.
public struct ApprovalOutcome: Codable, Sendable, Equatable {
    public let ok: Bool
    public let error: String?
    public let result: JSONValue?
}

// `POST /pending-actions/:id/deny` -- exact response shape per
// mobile/PROTOCOL.md §6.
public struct DenyOutcome: Codable, Sendable, Equatable {
    public let id: String
    public let status: String
}
