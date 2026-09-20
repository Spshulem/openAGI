import Foundation

// `GET /tasks/clarifications` -- the daemon's "ask me when you can't decide"
// queue (src/clarification-store.js). mobile/FEATURES.md describes the
// answer as "a free-text answer", but the daemon only accepts one of four
// fixed values (`ClarificationStore.answer` throws 400 on anything else) --
// this client follows the daemon's actual contract, not that prose. See the
// phase report for the full note.
public struct Clarification: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let taskId: String
    public let question: String
    public let context: String
    public let proposedAction: String
    public let confidence: Double?
    public let sources: [String]
    public let status: String
    public let answer: String?
    public let answeredAt: Date?
    public let createdAt: Date
}

// The daemon's exact enumeration (`VALID_ANSWERS` in
// src/clarification-store.js); any other value 400s.
public enum ClarificationAnswer: String, Sendable, CaseIterable, Identifiable {
    case yes, inProgress = "in_progress", no, dropped

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .yes: return "Yes, done"
        case .inProgress: return "Still working on it"
        case .no: return "No, not done"
        case .dropped: return "Not doing this"
        }
    }
}

// `POST /tasks/clarifications/:id/answer`'s response: `{clarification, task}`
// -- `task` is only present when the answer resolved a linked task
// (`ClarificationStore.answer`'s "no" branch leaves it unset).
public struct ClarificationAnswerResponse: Codable, Sendable {
    public let clarification: Clarification
    public let task: TaskRecord?
}
