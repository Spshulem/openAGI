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

    private func stringArg(_ key: String) -> String? {
        guard let args, case .object(let values) = args,
              case .string(let value)? = values[key] else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static let genericComputerSummaries: Set<String> = [
        "open computer use",
        "computer use",
        "start computer use",
        "start computer use session",
        "start_computer_use_session",
        "open computer use session"
    ]

    public var displayTitle: String {
        let trimmedSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if toolName == "start_computer_use_session" {
            if let goal = stringArg("goal") { return goal }
            if !trimmedSummary.isEmpty && !Self.genericComputerSummaries.contains(trimmedSummary.lowercased()) {
                return trimmedSummary
            }
            if let node = stringArg("nodeName") ?? stringArg("node") ?? stringArg("nodeId") {
                return "Control \(node)"
            }
            return "Computer control request"
        }
        if !trimmedSummary.isEmpty && trimmedSummary.caseInsensitiveCompare(toolName) != .orderedSame {
            return trimmedSummary
        }
        return toolName
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    public var displaySubtitle: String {
        if toolName == "start_computer_use_session" {
            let node = stringArg("nodeName") ?? stringArg("node") ?? stringArg("nodeId")
            return ["Computer Use", node].compactMap { $0 }.joined(separator: " · ")
        }
        let lower = toolName.lowercased()
        if lower.hasPrefix("fleet_") { return "Coding Supervisor" }
        if lower.contains("message") || lower.contains("email") || lower.contains("telegram") { return "Message" }
        if lower.hasPrefix("gh_") || lower.contains("github") || lower.contains("pull_request") { return "GitHub" }
        if lower.contains("shell") || lower.contains("command") || lower.contains("bash") || lower.contains("exec") { return "Command" }
        if lower.contains("schedule") || lower.contains("cron") { return "Schedule" }
        return toolName
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    // `/pending-actions` is daemon-wide: keep only the approvals this
    // conversation raised since `since`, before limiting, so other chats'
    // requests can neither appear here nor displace this turn's own.
    public static func raised(in actions: [PendingAction], thread: ConversationThread, conversationID: String,
                              since: Date, scopedToSession: Bool = true, excluding hidden: Set<String> = [],
                              limit: Int = 3) -> [PendingAction] {
        let session = "devices:\(thread.rawValue):\(conversationID)"
        // Newest request first: a card asked for again outranks its creation date.
        return Array(actions
            // Cards put away in this chat are dropped before the limit, so
            // they never take a slot from one still waiting.
            .filter { (!scopedToSession || $0.sessionID == session) && $0.lastRaisedAt >= since.addingTimeInterval(-5)
                && !hidden.contains($0.id) }
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
