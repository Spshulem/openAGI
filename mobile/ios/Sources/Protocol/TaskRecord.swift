import Foundation

// The full task shape from `GET /tasks`, `GET /tasks/:id`, `POST /tasks`,
// `PATCH /tasks/:id`, and `POST /tasks/:id/complete` -- distinct from
// `TaskItem`, which is the smaller shape `GET /mobile/summary` embeds (no
// `overdue` field on this one; the daemon only computes that for the
// summary's `today` list, per mobile/PROTOCOL.md §4 vs §5). Kept as its own
// type rather than folding into `TaskItem` so neither the widget's minimal
// shape nor this one has to carry fields the other doesn't have.
public struct TaskRecord: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let queue: String
    public let title: String
    public let description: String
    public let bucket: String
    public let priority: Int
    public let category: String?
    public let tags: [String]
    public let source: String
    public let sourceId: String?
    public let sourceUrl: String?
    public let status: String
    public let dueDate: Date?
    public let scheduledFor: Date?
    public let parentGoalId: String?
    public let dependsOn: [String]
    public let createdAt: Date
    public let updatedAt: Date
    public let completedAt: Date?
    public let completedVia: String?
}

public struct TasksListResponse: Codable, Sendable {
    public let tasks: [TaskRecord]
}

// mobile/PROTOCOL.md §5's enumerated valid values -- kept as `CaseIterable`
// so Tasks' bucket sections and pickers can drive directly from this list
// rather than a hand-maintained duplicate.
public enum TaskBucket: String, Codable, Sendable, CaseIterable, Identifiable {
    case today, thisWeek = "this_week", thisMonth = "this_month",
         thisQuarter = "this_quarter", thisYear = "this_year", someday, done

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .today: return "Today"
        case .thisWeek: return "This week"
        case .thisMonth: return "This month"
        case .thisQuarter: return "This quarter"
        case .thisYear: return "This year"
        case .someday: return "Someday"
        case .done: return "Done"
        }
    }
}

public enum TaskStatusValue: String, Codable, Sendable, CaseIterable, Identifiable {
    case pending, inProgress = "in_progress", blocked, completed, cancelled

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .pending: return "Pending"
        case .inProgress: return "In progress"
        case .blocked: return "Blocked"
        case .completed: return "Completed"
        case .cancelled: return "Cancelled"
        }
    }
}

public enum TaskQueue: String, Codable, Sendable, CaseIterable, Identifiable {
    case user, agent
    public var id: String { rawValue }
    public var label: String { self == .user ? "Yours" : "Agent's" }
}

// What `POST /tasks` needs; only `title` is required.
public struct NewTaskInput: Sendable, Equatable {
    public var title: String
    public var bucket: TaskBucket
    public var priority: Int?
    public var dueDate: Date?

    public init(title: String, bucket: TaskBucket = .today, priority: Int? = nil, dueDate: Date? = nil) {
        self.title = title
        self.bucket = bucket
        self.priority = priority
        self.dueDate = dueDate
    }
}

// What `PATCH /tasks/:id` sends -- every field optional, so only what
// actually changed goes over the wire.
public struct TaskPatch: Sendable, Equatable {
    public var title: String?
    public var bucket: TaskBucket?
    public var priority: Int?
    public var dueDate: Date??  // outer nil = leave alone, inner nil = clear it
    public var status: TaskStatusValue?

    public init(title: String? = nil, bucket: TaskBucket? = nil, priority: Int? = nil,
                dueDate: Date?? = nil, status: TaskStatusValue? = nil) {
        self.title = title
        self.bucket = bucket
        self.priority = priority
        self.dueDate = dueDate
        self.status = status
    }
}
