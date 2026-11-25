import Foundation

// The full task shape from `GET /tasks`, `GET /tasks/:id`, `POST /tasks`,
// `PATCH /tasks/:id`, and `POST /tasks/:id/complete` -- distinct from
// `TaskItem`, which is the smaller shape `GET /mobile/summary` embeds (no
// `overdue` field on this one; the daemon only computes that for the
// summary's `today` list, per mobile/PROTOCOL.md §4 vs §5). Kept as its own
// type rather than folding into `TaskItem` so neither the widget's minimal
// shape nor this one has to carry fields the other doesn't have.
public struct TaskAgentLease: Codable, Sendable, Equatable, Hashable {
    public let claimedAt: String?
    public let expiresAt: String?
    public let attempts: Int?

    public init(claimedAt: String? = nil, expiresAt: String? = nil, attempts: Int? = nil) {
        self.claimedAt = claimedAt
        self.expiresAt = expiresAt
        self.attempts = attempts
    }

    private enum CodingKeys: String, CodingKey { case claimedAt, expiresAt, attempts }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        claimedAt = (try? c?.decodeIfPresent(String.self, forKey: .claimedAt)) ?? nil
        expiresAt = (try? c?.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil
        attempts = (try? c?.decodeIfPresent(Int.self, forKey: .attempts)) ?? nil
    }
}

public struct TaskSourceMeta: Codable, Sendable, Equatable, Hashable {
    public let threadKey: String?
    public let project: String?
    public let subchannel: String?
    public let actor: String?
    public let blockedReason: String?
    public let agentLease: TaskAgentLease?

    public init(
        threadKey: String? = nil,
        project: String? = nil,
        subchannel: String? = nil,
        actor: String? = nil,
        blockedReason: String? = nil,
        agentLease: TaskAgentLease? = nil
    ) {
        self.threadKey = threadKey
        self.project = project
        self.subchannel = subchannel
        self.actor = actor
        self.blockedReason = blockedReason
        self.agentLease = agentLease
    }

    private enum CodingKeys: String, CodingKey {
        case threadKey, project, subchannel, actor, blockedReason, agentLease
    }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        threadKey = (try? c?.decodeIfPresent(String.self, forKey: .threadKey)) ?? nil
        project = (try? c?.decodeIfPresent(String.self, forKey: .project)) ?? nil
        subchannel = (try? c?.decodeIfPresent(String.self, forKey: .subchannel)) ?? nil
        actor = (try? c?.decodeIfPresent(String.self, forKey: .actor)) ?? nil
        blockedReason = (try? c?.decodeIfPresent(String.self, forKey: .blockedReason)) ?? nil
        agentLease = (try? c?.decodeIfPresent(TaskAgentLease.self, forKey: .agentLease)) ?? nil
    }
}

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
    public let sourceMeta: TaskSourceMeta?
    public let status: String
    public let dueDate: Date?
    public let scheduledFor: Date?
    public let parentGoalId: String?
    public let dependsOn: [String]
    public let createdAt: Date
    public let updatedAt: Date
    public let completedAt: Date?
    public let completedVia: String?

    public init(
        id: String,
        queue: String,
        title: String,
        description: String,
        bucket: String,
        priority: Int,
        category: String? = nil,
        tags: [String] = [],
        source: String,
        sourceId: String? = nil,
        sourceUrl: String? = nil,
        sourceMeta: TaskSourceMeta? = nil,
        status: String,
        dueDate: Date? = nil,
        scheduledFor: Date? = nil,
        parentGoalId: String? = nil,
        dependsOn: [String] = [],
        createdAt: Date,
        updatedAt: Date,
        completedAt: Date? = nil,
        completedVia: String? = nil
    ) {
        self.id = id
        self.queue = queue
        self.title = title
        self.description = description
        self.bucket = bucket
        self.priority = priority
        self.category = category
        self.tags = tags
        self.source = source
        self.sourceId = sourceId
        self.sourceUrl = sourceUrl
        self.sourceMeta = sourceMeta
        self.status = status
        self.dueDate = dueDate
        self.scheduledFor = scheduledFor
        self.parentGoalId = parentGoalId
        self.dependsOn = dependsOn
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.completedVia = completedVia
    }
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
