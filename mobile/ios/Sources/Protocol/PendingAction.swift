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
    public let expiresAt: Date?
    public let decidedAt: Date?
    public let decidedBy: String?
    public let result: JSONValue?
    public let error: String?
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
