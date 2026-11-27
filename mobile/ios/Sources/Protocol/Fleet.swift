import Foundation

// GET /fleet/api/state and the mutations that return it -- the fleet
// supervisor's view of every coding thread it watches (src/fleet/supervisor.js
// getState, src/fleet/routes.js). Mirrors Android's FleetModels.kt. The
// supervisor is newer than every other surface here and still growing, so
// every field is optional or defaulted and decoded leniently: an older
// daemon, a first run with no scan yet, or a field renamed next week must
// degrade to an emptier screen, never to a decode failure that blanks it.

extension KeyedDecodingContainer {
    // A present-but-wrong-typed value reads as absent instead of throwing.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }

    // Bad elements are dropped; a missing or null list is empty.
    func lenientList<T: Decodable & Sendable>(_ type: T.Type, _ key: Key) -> [T] {
        (lenient([Lenient<T>].self, key) ?? []).compactMap(\.value)
    }
}

public extension JSONValue {
    // `lastError` and each `sourceErrors` entry are a string today; the
    // dashboard also accepts `{ message }`. Blank means no error.
    var fleetText: String? {
        switch self {
        case .string(let text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
        case .object(let fields):
            if case .string(let text)? = fields["message"], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text
            }
            return nil
        default:
            return nil
        }
    }
}

public struct FleetActivityEvent: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: String
    public var actor: String?
    public var project: String?
    public var subchannel: String?
    public var title: String
    public var detail: String?
    public var threadKey: String?
    public var taskId: String?
    public var prRef: String?
    public var labels: [String]
    public var at: Date?

    public init(id: String, kind: String = "action", actor: String? = nil, project: String? = nil,
                subchannel: String? = nil, title: String, detail: String? = nil, threadKey: String? = nil,
                taskId: String? = nil, prRef: String? = nil, labels: [String] = [], at: Date? = nil) {
        self.id = id
        self.kind = kind
        self.actor = actor
        self.project = project
        self.subchannel = subchannel
        self.title = title
        self.detail = detail
        self.threadKey = threadKey
        self.taskId = taskId
        self.prRef = prRef
        self.labels = labels
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, actor, project, subchannel, title, detail, threadKey, taskId, prRef, labels, at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        kind = c.lenient(String.self, .kind) ?? "action"
        actor = c.lenient(String.self, .actor)
        project = c.lenient(String.self, .project)
        subchannel = c.lenient(String.self, .subchannel)
        title = c.lenient(String.self, .title) ?? "Activity"
        detail = c.lenient(String.self, .detail)
        threadKey = c.lenient(String.self, .threadKey)
        taskId = c.lenient(String.self, .taskId)
        prRef = c.lenient(String.self, .prRef)
        labels = c.lenientList(String.self, .labels)
        at = c.lenient(Date.self, .at)
    }
}

public struct FleetState: Decodable, Sendable, Equatable {
    public var mode: String?
    public var enabled: Bool
    public var running: Bool
    public var lastTickAt: Date?
    public var nextTickAt: Date?
    public var lastError: JSONValue?
    public var snapshot: FleetSnapshot?
    public var questions: [FleetQuestion]
    public var actions: [FleetAction]
    public var cards: [SupervisorCard]
    public var activityEvents: [FleetActivityEvent]
    public var preferences: SupervisorPreferences?
    public var autonomy: SupervisorAutonomy?
    public var activeSummary: SupervisorActiveSummary?
    public var catchUpSummary: String?

    public var lastErrorText: String? { lastError?.fleetText }

    public init(mode: String? = nil, enabled: Bool = false, running: Bool = false, lastTickAt: Date? = nil,
                nextTickAt: Date? = nil,
                lastError: JSONValue? = nil, snapshot: FleetSnapshot? = nil,
                questions: [FleetQuestion] = [], actions: [FleetAction] = [],
                cards: [SupervisorCard] = [], activityEvents: [FleetActivityEvent] = [],
                preferences: SupervisorPreferences? = nil,
                autonomy: SupervisorAutonomy? = nil, activeSummary: SupervisorActiveSummary? = nil,
                catchUpSummary: String? = nil) {
        self.mode = mode
        self.enabled = enabled
        self.running = running
        self.lastTickAt = lastTickAt
        self.nextTickAt = nextTickAt
        self.lastError = lastError
        self.snapshot = snapshot
        self.questions = questions
        self.actions = actions
        self.cards = cards
        self.activityEvents = activityEvents
        self.preferences = preferences
        self.autonomy = autonomy
        self.activeSummary = activeSummary
        self.catchUpSummary = catchUpSummary
    }

    private enum CodingKeys: String, CodingKey {
        case mode, enabled, running, lastTickAt, nextTickAt, lastError, snapshot, questions, actions
        case cards, activityEvents, preferences, autonomy, activeSummary, catchUpSummary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = c.lenient(String.self, .mode)
        enabled = c.lenient(Bool.self, .enabled) ?? false
        running = c.lenient(Bool.self, .running) ?? false
        lastTickAt = c.lenient(Date.self, .lastTickAt)
        nextTickAt = c.lenient(Date.self, .nextTickAt)
        lastError = c.lenient(JSONValue.self, .lastError)
        snapshot = c.lenient(FleetSnapshot.self, .snapshot)
        questions = c.lenientList(FleetQuestion.self, .questions)
        actions = c.lenientList(FleetAction.self, .actions)
        cards = c.lenientList(SupervisorCard.self, .cards)
        activityEvents = c.lenientList(FleetActivityEvent.self, .activityEvents)
        preferences = c.lenient(SupervisorPreferences.self, .preferences)
        autonomy = c.lenient(SupervisorAutonomy.self, .autonomy)
        activeSummary = c.lenient(SupervisorActiveSummary.self, .activeSummary)
        catchUpSummary = c.lenient(String.self, .catchUpSummary)
    }
}

// Main-owned Needs You walkthrough state. G2 and iOS use the same cursor and
// stable card/question identity, so moving through the deck on one device is
// visible on the other without copying approval authority to the glasses.
public struct SupervisorWalkthroughItem: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: String
    public var title: String
    public var summary: String
    public var questionId: String?
    public var threadKey: String?
    public var cardId: String?

    private enum CodingKeys: String, CodingKey { case id, kind, title, summary, questionId, threadKey, cardId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        kind = c.lenient(String.self, .kind) ?? "question"
        title = c.lenient(String.self, .title) ?? "Needs your decision"
        summary = c.lenient(String.self, .summary) ?? ""
        questionId = c.lenient(String.self, .questionId)
        threadKey = c.lenient(String.self, .threadKey)
        cardId = c.lenient(String.self, .cardId)
    }
}

public struct SupervisorWalkthrough: Decodable, Sendable, Equatable {
    public var active: Bool
    public var paused: Bool
    public var currentId: String?
    public var total: Int
    public var updatedAt: Date?
    public var current: SupervisorWalkthroughItem?
    public var items: [SupervisorWalkthroughItem]

    private enum CodingKeys: String, CodingKey { case active, paused, currentId, total, updatedAt, current, items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.lenient(Bool.self, .active) ?? false
        paused = c.lenient(Bool.self, .paused) ?? false
        currentId = c.lenient(String.self, .currentId)
        total = c.lenient(Int.self, .total) ?? 0
        updatedAt = c.lenient(Date.self, .updatedAt)
        current = c.lenient(SupervisorWalkthroughItem.self, .current)
        items = c.lenientList(SupervisorWalkthroughItem.self, .items)
    }
}

public struct FleetSnapshot: Decodable, Sendable, Equatable {
    public var at: Date?
    public var threads: [FleetThread]
    public var sourceErrors: [String: JSONValue]

    // Only sources that actually carry a message; an empty entry is not a failure.
    public var sourceErrorTexts: [String: String] {
        sourceErrors.compactMapValues(\.fleetText)
    }

    public init(at: Date? = nil, threads: [FleetThread] = [], sourceErrors: [String: JSONValue] = [:]) {
        self.at = at
        self.threads = threads
        self.sourceErrors = sourceErrors
    }

    private enum CodingKeys: String, CodingKey { case at, threads, sourceErrors }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.lenient(Date.self, .at)
        threads = c.lenientList(FleetThread.self, .threads)
        sourceErrors = c.lenient([String: JSONValue].self, .sourceErrors) ?? [:]
    }
}

public struct FleetThreadDetailResponse: Decodable, Sendable {
    public var thread: FleetThreadDetail
}

public struct FleetLastAgentMessage: Decodable, Sendable {
    public var text: String
}

public struct FleetConversation: Decodable, Sendable {
    public var messages: [FleetConversationMessage]
    public var truncated: Bool
    public var unavailableReason: String?
}

public struct FleetConversationMessage: Decodable, Sendable, Identifiable {
    public var id: String
    public var role: String
    public var text: String
    public var at: Date?
    public var actor: String?

    public init(id: String, role: String, text: String, at: Date? = nil, actor: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.actor = actor
    }

    private enum CodingKeys: String, CodingKey { case id, role, text, at, actor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        role = c.lenient(String.self, .role) ?? "assistant"
        text = c.lenient(String.self, .text) ?? ""
        at = c.lenient(Date.self, .at)
        actor = c.lenient(String.self, .actor)
    }
}

public struct FleetThread: Decodable, Sendable, Equatable, Identifiable {
    public var key: String
    public var kind: String?
    public var title: String?
    public var project: String?
    public var workspace: String?
    public var repo: String?
    public var branch: String?
    public var agentStatus: String?
    public var state: String?
    // Absent on a daemon older than the health field; FleetHealth.of falls
    // back to the same mapping the daemon uses.
    public var health: String?
    public var reason: String?
    public var blockers: [String]
    public var pr: FleetPR?
    public var lastActivityAt: Date?
    public var lastAgentText: String?
    public var error: FleetThreadError?
    public var live: Bool
    public var decision: FleetDecision?
    public var nextCheckAt: Date?
    public var watchdog: FleetWatchdog?
    public var actorLabel: String?
    public var subchannel: String?
    public var labels: [String]

    public var id: String { key }

    public init(key: String, kind: String? = nil, title: String? = nil, project: String? = nil, workspace: String? = nil, repo: String? = nil,
                branch: String? = nil, agentStatus: String? = nil, state: String? = nil, health: String? = nil,
                reason: String? = nil, blockers: [String] = [], pr: FleetPR? = nil, lastActivityAt: Date? = nil,
                lastAgentText: String? = nil, error: FleetThreadError? = nil, live: Bool = false,
                decision: FleetDecision? = nil, nextCheckAt: Date? = nil, watchdog: FleetWatchdog? = nil,
                actorLabel: String? = nil, subchannel: String? = nil, labels: [String] = []) {
        self.key = key
        self.kind = kind
        self.title = title
        self.project = project
        self.workspace = workspace
        self.repo = repo
        self.branch = branch
        self.agentStatus = agentStatus
        self.state = state
        self.health = health
        self.reason = reason
        self.blockers = blockers
        self.pr = pr
        self.lastActivityAt = lastActivityAt
        self.lastAgentText = lastAgentText
        self.error = error
        self.live = live
        self.decision = decision
        self.nextCheckAt = nextCheckAt
        self.watchdog = watchdog
        self.actorLabel = actorLabel
        self.subchannel = subchannel
        self.labels = labels
    }

    private enum CodingKeys: String, CodingKey {
        case key, kind, title, project, workspace, repo, branch, agentStatus, state, health, reason, blockers, pr
        case lastActivityAt, lastAgentText, error, live, decision
        case nextCheckAt, watchdog, actorLabel, subchannel, labels
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(String.self, .key) ?? ""
        kind = c.lenient(String.self, .kind)
        title = c.lenient(String.self, .title)
        project = c.lenient(String.self, .project)
        workspace = c.lenient(String.self, .workspace)
        repo = c.lenient(String.self, .repo)
        branch = c.lenient(String.self, .branch)
        agentStatus = c.lenient(String.self, .agentStatus)
        state = c.lenient(String.self, .state)
        health = c.lenient(String.self, .health)
        reason = c.lenient(String.self, .reason)
        blockers = c.lenientList(String.self, .blockers)
        pr = c.lenient(FleetPR.self, .pr)
        lastActivityAt = c.lenient(Date.self, .lastActivityAt)
        lastAgentText = c.lenient(String.self, .lastAgentText)
        error = c.lenient(FleetThreadError.self, .error)
        live = c.lenient(Bool.self, .live) ?? false
        decision = c.lenient(FleetDecision.self, .decision)
        nextCheckAt = c.lenient(Date.self, .nextCheckAt)
        watchdog = c.lenient(FleetWatchdog.self, .watchdog)
        actorLabel = c.lenient(String.self, .actorLabel)
        subchannel = c.lenient(String.self, .subchannel)
        labels = c.lenientList(String.self, .labels)
    }
}

public struct FleetWatchdogDiagnosis: Decodable, Sendable, Equatable {
    public var kind: String?
    public var label: String?
    public var resolution: String?

    public init(kind: String? = nil, label: String? = nil, resolution: String? = nil) {
        self.kind = kind
        self.label = label
        self.resolution = resolution
    }

    private enum CodingKeys: String, CodingKey { case kind, label, resolution }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(String.self, .kind)
        label = c.lenient(String.self, .label)
        resolution = c.lenient(String.self, .resolution)
    }
}

public struct FleetWatchdog: Decodable, Sendable, Equatable {
    public var phase: String?
    public var expectedMinutes: Int?
    public var silentMinutes: Int?
    public var checkInDueAt: Date?
    public var overdue: Bool
    public var overdueMinutes: Int
    public var severelyStuck: Bool
    public var status: String?
    public var diagnosis: FleetWatchdogDiagnosis?

    public var badgeText: String? {
        if severelyStuck {
            let dur = Self.compactDuration(silentMinutes ?? overdueMinutes)
            if let diag = diagnosis?.label, !diag.isEmpty {
                return "Stuck \(dur) · \(diag)"
            }
            return "Stuck \(dur)"
        }
        if overdue {
            if let diag = diagnosis?.label, !diag.isEmpty {
                return "Check-in overdue · \(diag)"
            }
            let mins = max(1, overdueMinutes)
            return "Check-in overdue +\(Self.compactDuration(mins))"
        }
        if let exp = expectedMinutes, exp > 0 {
            if let due = checkInDueAt {
                let remMin = max(1, Int(ceil(due.timeIntervalSinceNow / 60)))
                if due.timeIntervalSinceNow > 0 {
                    return "Check-in in \(Self.compactDuration(remMin)) (est. \(exp)m)"
                }
            }
            return "Est. check-in \(exp)m"
        }
        return nil
    }

    public var isAlert: Bool {
        severelyStuck || overdue
    }

    private static func compactDuration(_ minutes: Int) -> String {
        let m = max(1, minutes)
        if m < 60 { return "\(m)m" }
        let h = m / 60
        let rem = m % 60
        return (rem > 0 && h < 10) ? "\(h)h \(rem)m" : "\(h)h"
    }

    public init(phase: String? = nil, expectedMinutes: Int? = nil, silentMinutes: Int? = nil,
                checkInDueAt: Date? = nil, overdue: Bool = false, overdueMinutes: Int = 0,
                severelyStuck: Bool = false, status: String? = nil, diagnosis: FleetWatchdogDiagnosis? = nil) {
        self.phase = phase
        self.expectedMinutes = expectedMinutes
        self.silentMinutes = silentMinutes
        self.checkInDueAt = checkInDueAt
        self.overdue = overdue
        self.overdueMinutes = overdueMinutes
        self.severelyStuck = severelyStuck
        self.status = status
        self.diagnosis = diagnosis
    }

    private enum CodingKeys: String, CodingKey {
        case phase, expectedMinutes, silentMinutes, checkInDueAt, overdue, overdueMinutes, severelyStuck, status, diagnosis
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = c.lenient(String.self, .phase)
        expectedMinutes = c.lenient(Int.self, .expectedMinutes)
        silentMinutes = c.lenient(Int.self, .silentMinutes)
        checkInDueAt = c.lenient(Date.self, .checkInDueAt)
        overdue = c.lenient(Bool.self, .overdue) ?? false
        overdueMinutes = c.lenient(Int.self, .overdueMinutes) ?? 0
        severelyStuck = c.lenient(Bool.self, .severelyStuck) ?? false
        status = c.lenient(String.self, .status)
        diagnosis = c.lenient(FleetWatchdogDiagnosis.self, .diagnosis)
    }
}
public struct FleetPR: Decodable, Sendable, Equatable {
    public var ref: String?
    public var url: String?
    public var state: String?
    public var title: String?
    public var bodySummary: String?
    public var additions: Int?
    public var deletions: Int?
    public var changedFiles: Int?
    public var files: [String]
    public var ci: FleetCI?
    public var unresolvedThreads: Int?

    public init(ref: String? = nil, url: String? = nil, state: String? = nil, title: String? = nil,
                bodySummary: String? = nil, additions: Int? = nil, deletions: Int? = nil,
                changedFiles: Int? = nil, files: [String] = [],
                ci: FleetCI? = nil, unresolvedThreads: Int? = nil) {
        self.ref = ref
        self.url = url
        self.state = state
        self.title = title
        self.bodySummary = bodySummary
        self.additions = additions
        self.deletions = deletions
        self.changedFiles = changedFiles
        self.files = files
        self.ci = ci
        self.unresolvedThreads = unresolvedThreads
    }

    private enum CodingKeys: String, CodingKey {
        case ref, url, state, title, bodySummary, additions, deletions, changedFiles, files, ci, unresolvedThreads
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = c.lenient(String.self, .ref)
        url = c.lenient(String.self, .url)
        state = c.lenient(String.self, .state)
        title = c.lenient(String.self, .title)
        bodySummary = c.lenient(String.self, .bodySummary)
        additions = c.lenient(Int.self, .additions)
        deletions = c.lenient(Int.self, .deletions)
        changedFiles = c.lenient(Int.self, .changedFiles)
        files = c.lenientList(String.self, .files)
        ci = c.lenient(FleetCI.self, .ci)
        unresolvedThreads = c.lenient(Int.self, .unresolvedThreads)
    }
}

public struct FleetCI: Decodable, Sendable, Equatable {
    public var state: String?
    public var failing: [String]
    public var pending: [String]

    public init(state: String? = nil, failing: [String] = [], pending: [String] = []) {
        self.state = state
        self.failing = failing
        self.pending = pending
    }

    private enum CodingKeys: String, CodingKey { case state, failing, pending }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = c.lenient(String.self, .state)
        failing = c.lenientList(String.self, .failing)
        pending = c.lenientList(String.self, .pending)
    }
}

public struct FleetThreadError: Decodable, Sendable, Equatable {
    public var kind: String?
    public var resetAt: Date?

    public init(kind: String? = nil, resetAt: Date? = nil) {
        self.kind = kind
        self.resetAt = resetAt
    }

    private enum CodingKeys: String, CodingKey { case kind, resetAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(String.self, .kind)
        resetAt = c.lenient(Date.self, .resetAt)
    }
}

public struct FleetDecision: Decodable, Sendable, Equatable {
    public var action: String?
    public var playbook: String?
    public var reason: String?
    public var notBefore: Date?

    public init(action: String? = nil, playbook: String? = nil, reason: String? = nil, notBefore: Date? = nil) {
        self.action = action
        self.playbook = playbook
        self.reason = reason
        self.notBefore = notBefore
    }

    private enum CodingKeys: String, CodingKey { case action, playbook, reason, notBefore }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = c.lenient(String.self, .action)
        playbook = c.lenient(String.self, .playbook)
        reason = c.lenient(String.self, .reason)
        notBefore = c.lenient(Date.self, .notBefore)
    }
}

public struct SupervisorDecisionSource: Decodable, Sendable, Equatable {
    public var questionId: String?
    public var threadKey: String?
    public var threadKeys: [String]
    public var app: String?
    public var cardId: String?
    public var itemId: String?

    private enum CodingKeys: String, CodingKey { case questionId, threadKey, threadKeys, app, cardId, itemId }

    public init(questionId: String? = nil, threadKey: String? = nil, threadKeys: [String] = [], app: String? = nil, cardId: String? = nil, itemId: String? = nil) {
        self.questionId = questionId; self.threadKey = threadKey; self.threadKeys = threadKeys
        self.app = app; self.cardId = cardId; self.itemId = itemId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        questionId = c.lenient(String.self, .questionId)
        threadKey = c.lenient(String.self, .threadKey)
        threadKeys = c.lenientList(String.self, .threadKeys)
        app = c.lenient(String.self, .app)
        cardId = c.lenient(String.self, .cardId)
        itemId = c.lenient(String.self, .itemId)
    }
}

public struct FleetDecisionItem: Decodable, Sendable, Equatable, Identifiable {
    public var itemId: String?
    public var source: SupervisorDecisionSource?
    public var headline: String
    public var options: [String]
    public var multiSelect: Bool
    public var freeText: Bool
    public var active: Bool
    public var id: String { itemId ?? headline }

    private enum CodingKeys: String, CodingKey { case itemId, source, headline, options, multiSelect, freeText, active }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = c.lenient(String.self, .itemId)
        source = c.lenient(SupervisorDecisionSource.self, .source)
        headline = c.lenient(String.self, .headline) ?? "Owner decision"
        options = c.lenientList(String.self, .options)
        multiSelect = c.lenient(Bool.self, .multiSelect) ?? false
        freeText = c.lenient(Bool.self, .freeText) ?? false
        active = c.lenient(Bool.self, .active) ?? false
    }
}

public struct FleetQuestion: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String?
    public var body: String?
    public var options: [String]
    public var kind: String?
    public var threadKey: String?
    public var threadKeys: [String]?
    public var prRef: String?
    public var createdAt: Date?
    public var needsYou: Bool
    public var decisionHeadline: String?
    public var decisionFact: String?
    public var decisionSource: SupervisorDecisionSource?
    public var decisionAction: SupervisorCardAction?
    public var remainingItemIds: [String]
    public var decisionItems: [FleetDecisionItem]

    public init(id: String, title: String? = nil, body: String? = nil, options: [String] = [], kind: String? = nil,
                threadKey: String? = nil, threadKeys: [String]? = nil, prRef: String? = nil, createdAt: Date? = nil,
                needsYou: Bool = true, decisionHeadline: String? = nil, decisionFact: String? = nil,
                decisionSource: SupervisorDecisionSource? = nil, decisionAction: SupervisorCardAction? = nil,
                remainingItemIds: [String] = [], decisionItems: [FleetDecisionItem] = []) {
        self.id = id
        self.title = title
        self.body = body
        self.options = options
        self.kind = kind
        self.threadKey = threadKey
        self.threadKeys = threadKeys
        self.prRef = prRef
        self.createdAt = createdAt
        self.needsYou = needsYou; self.decisionHeadline = decisionHeadline; self.decisionFact = decisionFact
        self.decisionSource = decisionSource; self.decisionAction = decisionAction; self.remainingItemIds = remainingItemIds; self.decisionItems = decisionItems
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, body, options, kind, threadKey, threadKeys, prRef, createdAt, needsYou, decisionHeadline, decisionFact, decisionSource, decisionAction, remainingItemIds, decisionItems
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        title = c.lenient(String.self, .title)
        body = c.lenient(String.self, .body)
        options = c.lenientList(String.self, .options)
        kind = c.lenient(String.self, .kind)
        threadKey = c.lenient(String.self, .threadKey)
        threadKeys = c.lenient([String].self, .threadKeys)
        prRef = c.lenient(String.self, .prRef)
        createdAt = c.lenient(Date.self, .createdAt)
        needsYou = c.lenient(Bool.self, .needsYou) ?? true
        decisionHeadline = c.lenient(String.self, .decisionHeadline)
        decisionFact = c.lenient(String.self, .decisionFact)
        decisionSource = c.lenient(SupervisorDecisionSource.self, .decisionSource)
        decisionAction = c.lenient(SupervisorCardAction.self, .decisionAction)
        remainingItemIds = c.lenientList(String.self, .remainingItemIds)
        decisionItems = c.lenientList(FleetDecisionItem.self, .decisionItems)
    }
}

public struct FleetAction: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var status: String?
    public var playbook: String?
    public var threadKey: String?
    public var targetKey: String?
    public var message: String?
    public var reason: String?
    public var detail: String?
    public var at: Date?

    public init(id: String, status: String? = nil, playbook: String? = nil, threadKey: String? = nil,
                targetKey: String? = nil, message: String? = nil, reason: String? = nil, detail: String? = nil,
                at: Date? = nil) {
        self.id = id
        self.status = status
        self.playbook = playbook
        self.threadKey = threadKey
        self.targetKey = targetKey
        self.message = message
        self.reason = reason
        self.detail = detail
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case id, status, playbook, threadKey, targetKey, message, reason, detail, at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        status = c.lenient(String.self, .status)
        playbook = c.lenient(String.self, .playbook)
        threadKey = c.lenient(String.self, .threadKey)
        targetKey = c.lenient(String.self, .targetKey)
        message = c.lenient(String.self, .message)
        reason = c.lenient(String.self, .reason)
        detail = c.lenient(String.self, .detail)
        at = c.lenient(Date.self, .at)
    }
}

// How an answer or a proposed nudge reached (or failed to reach) the agent:
// status is "sent", "blocked", "failed" or "dry-run" (src/fleet/executor.js).
public struct FleetDelivery: Decodable, Sendable, Equatable {
    public var status: String?
    public var route: String?
    public var detail: String?
    // What became of an answer or reply: delivered, queued, ambiguous (may
    // have landed, not confirmed, never re-sent) or refused. Nil from an
    // older hub, where status decides.
    public var outcome: String?

    public init(status: String? = nil, route: String? = nil, detail: String? = nil, outcome: String? = nil) {
        self.status = status
        self.route = route
        self.detail = detail
        self.outcome = outcome
    }

    private enum CodingKeys: String, CodingKey { case status, route, detail, outcome }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(String.self, .status)
        route = c.lenient(String.self, .route)
        detail = c.lenient(String.self, .detail)
        outcome = c.lenient(String.self, .outcome)
    }
}

// POST /fleet/api/questions/:id (an answer or a dismissal; a dismissal
// carries no delivery) and POST /fleet/api/actions/:id/send.
public struct FleetMutationResult: Decodable, Sendable, Equatable {
    public var delivery: FleetDelivery?
    public var state: FleetState?

    public init(delivery: FleetDelivery? = nil, state: FleetState? = nil) {
        self.delivery = delivery
        self.state = state
    }

    private enum CodingKeys: String, CodingKey { case delivery, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        delivery = c.lenient(FleetDelivery.self, .delivery)
        state = c.lenient(FleetState.self, .state)
    }
}

public enum FleetMode: String, Sendable, CaseIterable {
    case observe, propose, auto
}

// The contract's four colours. The daemon sends `health` on every thread;
// the fallback below is the same table, for a daemon that does not yet.
public enum FleetHealth: String, Sendable, CaseIterable {
    case red, yellow, green, gray

    private static let greenStates: Set<String> = ["running", "waiting-ci", "local-verify", "asked-in-scope", "done"]
    private static let yellowStates: Set<String> = ["pr-not-ready", "idle-no-pr", "ready-needs-human"]
    private static let redStates: Set<String> = ["needs-human", "infra-blocked"]

    public static func of(_ thread: FleetThread) -> FleetHealth {
        if let wire = thread.health, let health = FleetHealth(rawValue: wire) { return health }
        return fallback(state: thread.state, hasError: thread.error != nil)
    }

    // Same order as the daemon's threadHealth (src/fleet/classify.js):
    // excluded or unknown is gray even with an error, since nothing about it
    // is known to be waiting on anyone; then an error outside a running turn
    // is red; then the state decides.
    public static func fallback(state: String?, hasError: Bool) -> FleetHealth {
        guard let state, greenStates.contains(state) || yellowStates.contains(state) || redStates.contains(state) else {
            return .gray
        }
        if hasError && state != "running" { return .red }
        if redStates.contains(state) { return .red }
        if yellowStates.contains(state) { return .yellow }
        return .green
    }
}

// Read-only context from the most recent supervisor scan. Decoded separately
// from FleetThread: the list intentionally carries a much shorter excerpt.
public struct FleetThreadDetail: Decodable, Sendable {
    public struct Message: Decodable, Sendable {
        public let text: String?
        public let at: Date?
    }
    public let key: String
    public let conversation: FleetConversation?
    public let lastAgentMessage: Message?
    public let lastOwnerMessage: Message?
    public let lastOwnerAt: Date?
    public let scannedAt: Date?
    public let activityTruncated: Bool?
}

// MARK: - Supervisor Duet Cards, Progressive Preferences & Search

public struct SupervisorCardAction: Decodable, Sendable, Equatable {
    public var op: String
    public var label: String
    public var value: String?
    public var destructive: Bool
    /// The hub's recommended option (src/fleet/decision-view.js). The hub
    /// orders it first; it is styled the same way everywhere.
    public var recommended: Bool
    /// Choosing this skips a required review using admin rights.
    public var adminBypass: Bool

    public init(op: String, label: String, value: String? = nil, destructive: Bool = false,
                recommended: Bool = false, adminBypass: Bool = false) {
        self.op = op
        self.label = label
        self.value = value
        self.destructive = destructive
        self.recommended = recommended
        self.adminBypass = adminBypass
    }

    private enum CodingKeys: String, CodingKey { case op, label, value, destructive, recommended, adminBypass }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        op = c.lenient(String.self, .op) ?? ""
        label = c.lenient(String.self, .label) ?? ""
        value = c.lenient(String.self, .value)
        destructive = c.lenient(Bool.self, .destructive) ?? false
        recommended = c.lenient(Bool.self, .recommended) ?? false
        adminBypass = c.lenient(Bool.self, .adminBypass) ?? false
    }
}

// MARK: - Decision contract (card.decisionView, src/fleet/decision-view.js)

/// Goal, status, decision, recommendation: what every decision card shows
/// before its buttons. Each section says when the source did not state it
/// (`unknown`) so the phone labels the gap instead of hiding or inventing it.
/// Absent on older hubs; cards then keep their previous rendering.
public struct SupervisorDecisionView: Decodable, Sendable, Equatable {
    public struct Goal: Decodable, Sendable, Equatable {
        public var title: String?
        public var text: String?
        public var unknown: Bool

        public init(title: String? = nil, text: String? = nil, unknown: Bool = false) {
            self.title = title
            self.text = text
            self.unknown = unknown
        }

        private enum CodingKeys: String, CodingKey { case title, text, unknown }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = c.lenient(String.self, .title)
            text = c.lenient(String.self, .text)
            unknown = c.lenient(Bool.self, .unknown) ?? (title == nil && text == nil)
        }
    }

    public struct PullRequest: Decodable, Sendable, Equatable, Identifiable {
        public var ref: String
        public var title: String?
        public var facts: [String]

        public var id: String { ref + (title ?? "") }

        public init(ref: String, title: String? = nil, facts: [String] = []) {
            self.ref = ref
            self.title = title
            self.facts = facts
        }

        private enum CodingKeys: String, CodingKey { case ref, title, facts }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ref = c.lenient(String.self, .ref) ?? ""
            title = c.lenient(String.self, .title)
            facts = c.lenientList(String.self, .facts)
        }
    }

    public struct Status: Decodable, Sendable, Equatable {
        public var done: [String]
        public var blocked: [String]
        public var unverified: [String]
        public var prs: [PullRequest]
        public var unknown: Bool

        public init(done: [String] = [], blocked: [String] = [], unverified: [String] = [],
                    prs: [PullRequest] = [], unknown: Bool = false) {
            self.done = done
            self.blocked = blocked
            self.unverified = unverified
            self.prs = prs
            self.unknown = unknown
        }

        private enum CodingKeys: String, CodingKey { case done, blocked, unverified, prs, unknown }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            done = c.lenientList(String.self, .done)
            blocked = c.lenientList(String.self, .blocked)
            unverified = c.lenientList(String.self, .unverified)
            prs = c.lenientList(PullRequest.self, .prs).filter { !$0.ref.isEmpty }
            unknown = c.lenient(Bool.self, .unknown)
                ?? (done.isEmpty && blocked.isEmpty && unverified.isEmpty && prs.isEmpty)
        }
    }

    public struct Option: Decodable, Sendable, Equatable, Identifiable {
        public var value: String
        public var label: String
        public var consequence: String?
        public var adminBypass: Bool
        public var recommended: Bool

        public var id: String { value.isEmpty ? label : value }

        public init(value: String, label: String, consequence: String? = nil,
                    adminBypass: Bool = false, recommended: Bool = false) {
            self.value = value
            self.label = label
            self.consequence = consequence
            self.adminBypass = adminBypass
            self.recommended = recommended
        }

        private enum CodingKeys: String, CodingKey { case value, label, consequence, adminBypass, recommended }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let rawLabel = c.lenient(String.self, .label)
            let rawValue = c.lenient(String.self, .value)
            label = rawLabel ?? rawValue ?? ""
            value = rawValue ?? rawLabel ?? ""
            consequence = c.lenient(String.self, .consequence)
            adminBypass = c.lenient(Bool.self, .adminBypass) ?? false
            recommended = c.lenient(Bool.self, .recommended) ?? false
        }
    }

    public struct Decision: Decodable, Sendable, Equatable {
        public var question: String?
        public var options: [Option]
        public var unknown: Bool

        public init(question: String? = nil, options: [Option] = [], unknown: Bool = false) {
            self.question = question
            self.options = options
            self.unknown = unknown
        }

        private enum CodingKeys: String, CodingKey { case question, options, unknown }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            question = c.lenient(String.self, .question)
            options = c.lenientList(Option.self, .options).filter { !$0.label.isEmpty }
            unknown = c.lenient(Bool.self, .unknown) ?? (question == nil && options.isEmpty)
        }
    }

    public struct Recommendation: Decodable, Sendable, Equatable {
        public var option: String?
        public var label: String?
        public var why: String?
        public var unknown: Bool

        public init(option: String? = nil, label: String? = nil, why: String? = nil, unknown: Bool = false) {
            self.option = option
            self.label = label
            self.why = why
            self.unknown = unknown
        }

        private enum CodingKeys: String, CodingKey { case option, label, why, unknown }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            option = c.lenient(String.self, .option)
            label = c.lenient(String.self, .label)
            why = c.lenient(String.self, .why)
            unknown = c.lenient(Bool.self, .unknown) ?? (option == nil && label == nil && why == nil)
        }
    }

    public struct Evidence: Decodable, Sendable, Equatable, Identifiable {
        public var label: String
        public var url: String

        public var id: String { url }

        public init(label: String, url: String) {
            self.label = label
            self.url = url
        }

        private enum CodingKeys: String, CodingKey { case label, url }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            url = c.lenient(String.self, .url) ?? ""
            label = c.lenient(String.self, .label) ?? url
        }
    }

    public var version: Int
    public var goal: Goal
    public var status: Status
    public var decision: Decision
    public var recommendation: Recommendation
    public var unknowns: [String]
    public var evidence: [Evidence]

    public init(version: Int = 1, goal: Goal = Goal(unknown: true), status: Status = Status(unknown: true),
                decision: Decision = Decision(unknown: true), recommendation: Recommendation = Recommendation(unknown: true),
                unknowns: [String] = [], evidence: [Evidence] = []) {
        self.version = version
        self.goal = goal
        self.status = status
        self.decision = decision
        self.recommendation = recommendation
        self.unknowns = unknowns
        self.evidence = evidence
    }

    private enum CodingKeys: String, CodingKey { case version, goal, status, decision, recommendation, unknowns, evidence }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenient(Int.self, .version) ?? 1
        // A missing section is an unknown one: labelled, never dropped.
        goal = c.lenient(Goal.self, .goal) ?? Goal(unknown: true)
        status = c.lenient(Status.self, .status) ?? Status(unknown: true)
        decision = c.lenient(Decision.self, .decision) ?? Decision(unknown: true)
        recommendation = c.lenient(Recommendation.self, .recommendation) ?? Recommendation(unknown: true)
        unknowns = c.lenientList(String.self, .unknowns)
        evidence = c.lenientList(Evidence.self, .evidence).filter { !$0.url.isEmpty }
    }
}

public struct SupervisorTimelineItem: Decodable, Sendable, Equatable, Identifiable {
    public var at: Date?
    public var label: String
    public var detail: String?

    public var id: String { "\(label)-\(detail ?? "")-\(at?.timeIntervalSince1970 ?? 0)" }

    public init(at: Date? = nil, label: String, detail: String? = nil) {
        self.at = at
        self.label = label
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey { case at, label, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.lenient(Date.self, .at)
        label = c.lenient(String.self, .label) ?? ""
        detail = c.lenient(String.self, .detail)
    }
}

public struct SupervisorResource: Decodable, Sendable, Equatable, Identifiable {
    public var kind: String
    public var label: String
    public var url: String?
    public var threadKey: String?
    public var serverId: String?
    public var agentId: String?

    public var id: String { "\(kind)-\(label)-\(url ?? threadKey ?? "")" }

    public init(kind: String, label: String, url: String? = nil, threadKey: String? = nil,
                serverId: String? = nil, agentId: String? = nil) {
        self.kind = kind
        self.label = label
        self.url = url
        self.threadKey = threadKey
        self.serverId = serverId
        self.agentId = agentId
    }

    private enum CodingKeys: String, CodingKey { case kind, label, url, threadKey, serverId, agentId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(String.self, .kind) ?? ""
        label = c.lenient(String.self, .label) ?? ""
        url = c.lenient(String.self, .url)
        threadKey = c.lenient(String.self, .threadKey)
        serverId = c.lenient(String.self, .serverId)
        agentId = c.lenient(String.self, .agentId)
    }
}

public struct FleetOpenChat: Decodable, Sendable, Equatable {
    public var app: String?
    public var url: String?
    public var label: String?
    public var serverId: String?
    public var agentId: String?
    public var note: String?

    public init(app: String? = nil, url: String? = nil, label: String? = nil,
                serverId: String? = nil, agentId: String? = nil, note: String? = nil) {
        self.app = app
        self.url = url
        self.label = label
        self.serverId = serverId
        self.agentId = agentId
        self.note = note
    }

    private enum CodingKeys: String, CodingKey { case app, url, label, serverId, agentId, note }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = c.lenient(String.self, .app)
        url = c.lenient(String.self, .url)
        label = c.lenient(String.self, .label)
        serverId = c.lenient(String.self, .serverId)
        agentId = c.lenient(String.self, .agentId)
        note = c.lenient(String.self, .note)
    }
}

public struct SupervisorPRGate: Decodable, Sendable, Equatable, Identifiable {
    public var label: String
    public var state: String?

    public var id: String { "\(label)-\(state ?? "")" }

    public init(label: String, state: String? = nil) {
        self.label = label
        self.state = state
    }

    private enum CodingKeys: String, CodingKey { case label, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = c.lenient(String.self, .label) ?? ""
        state = c.lenient(String.self, .state)
    }
}

public struct SupervisorPRContext: Decodable, Sendable, Equatable {
    public var ref: String?
    public var url: String?
    public var title: String?
    public var bodySummary: String?
    public var additions: Int?
    public var deletions: Int?
    public var changedFiles: Int?
    public var files: [String]
    public var gates: [SupervisorPRGate]
    public var ciState: String?
    public var mergeState: String?
    public var head: String?

    public init(ref: String? = nil, url: String? = nil, title: String? = nil, bodySummary: String? = nil,
                additions: Int? = nil, deletions: Int? = nil, changedFiles: Int? = nil,
                files: [String] = [], gates: [SupervisorPRGate] = [],
                ciState: String? = nil, mergeState: String? = nil, head: String? = nil) {
        self.ref = ref
        self.url = url
        self.title = title
        self.bodySummary = bodySummary
        self.additions = additions
        self.deletions = deletions
        self.changedFiles = changedFiles
        self.files = files
        self.gates = gates
        self.ciState = ciState
        self.mergeState = mergeState
        self.head = head
    }

    private enum CodingKeys: String, CodingKey {
        case ref, url, title, bodySummary, additions, deletions, changedFiles, files, gates, ciState, mergeState, head
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = c.lenient(String.self, .ref)
        url = c.lenient(String.self, .url)
        title = c.lenient(String.self, .title)
        bodySummary = c.lenient(String.self, .bodySummary)
        additions = c.lenient(Int.self, .additions)
        deletions = c.lenient(Int.self, .deletions)
        changedFiles = c.lenient(Int.self, .changedFiles)
        files = c.lenientList(String.self, .files)
        gates = c.lenientList(SupervisorPRGate.self, .gates)
        ciState = c.lenient(String.self, .ciState)
        mergeState = c.lenient(String.self, .mergeState)
        head = c.lenient(String.self, .head)
    }
}

public struct SupervisorRecentMessage: Decodable, Sendable, Equatable, Identifiable {
    public var role: String
    public var text: String
    public var at: Date?

    public var id: String { "\(role)-\(at?.timeIntervalSince1970 ?? 0)-\(text.prefix(32))" }

    public init(role: String, text: String, at: Date? = nil) {
        self.role = role
        self.text = text
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case role, text, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = c.lenient(String.self, .role) ?? "assistant"
        text = c.lenient(String.self, .text) ?? ""
        at = c.lenient(Date.self, .at)
    }
}

public struct SupervisorCardBrief: Decodable, Sendable, Equatable {
    public var context: String?
    public var currentState: String?
    public var whatChanged: String?
    public var decision: String?

    public init(context: String? = nil, currentState: String? = nil, whatChanged: String? = nil, decision: String? = nil) {
        self.context = context
        self.currentState = currentState
        self.whatChanged = whatChanged
        self.decision = decision
    }

    private enum CodingKeys: String, CodingKey { case context, currentState, whatChanged, decision }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        context = c.lenient(String.self, .context)
        currentState = c.lenient(String.self, .currentState)
        whatChanged = c.lenient(String.self, .whatChanged)
        decision = c.lenient(String.self, .decision)
    }
}

public struct SupervisorSuggestionPlan: Decodable, Sendable, Equatable {
    public var remedy: String?
    public var label: String?
    public var nextAction: String?
    public var acceptance: String?

    public init(remedy: String? = nil, label: String? = nil, nextAction: String? = nil, acceptance: String? = nil) {
        self.remedy = remedy
        self.label = label
        self.nextAction = nextAction
        self.acceptance = acceptance
    }

    private enum CodingKeys: String, CodingKey {
        case remedy, label, nextAction, acceptance
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        remedy = c.lenient(String.self, .remedy)
        label = c.lenient(String.self, .label)
        nextAction = c.lenient(String.self, .nextAction)
        acceptance = c.lenient(String.self, .acceptance)
    }
}

// MARK: - Asks with several questions (card.questionItems, src/fleet/decision-items.js)

/// One of several independent questions in a single ask. Present only when
/// an ask carries two or more; each is answered, skipped or retried on its
/// own and never folded into a group reply.
public struct SupervisorQuestionItem: Decodable, Sendable, Equatable, Identifiable {
    public struct State: Decodable, Sendable, Equatable {
        /// "unanswered" | "skipped" | "queued" | "delivered" | "failed".
        public var status: String
        public var answer: String?
        public var at: String?
        public var detail: String?

        public init(status: String = "unanswered", answer: String? = nil, at: String? = nil, detail: String? = nil) {
            self.status = status
            self.answer = answer
            self.at = at
            self.detail = detail
        }

        private enum CodingKeys: String, CodingKey { case status, answer, at, detail }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let raw = (c.lenient(String.self, .status) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            status = Self.known.contains(raw) ? raw : "unanswered"
            answer = c.lenient(String.self, .answer)
            at = c.lenient(String.self, .at)
            detail = c.lenient(String.self, .detail)
        }

        static let known: Set<String> = ["unanswered", "skipped", "queued", "delivered", "failed"]

        /// Sent to the agent (queued or confirmed): read-only on the phone.
        public var isSent: Bool { status == "queued" || status == "delivered" }
        /// Still needs the owner: unanswered, skipped, or failed to send.
        public var isOpen: Bool { !isSent }
    }

    public var itemId: String
    public var index: Int
    public var label: String?
    public var question: String
    public var context: String?
    public var choices: [String]
    public var freeText: Bool
    public var recommendation: String?
    public var unblocks: String?
    public var state: State

    public var id: String { itemId }

    public init(itemId: String, index: Int, label: String? = nil, question: String, context: String? = nil,
                choices: [String] = [], freeText: Bool = true, recommendation: String? = nil,
                unblocks: String? = nil, state: State = State()) {
        self.itemId = itemId
        self.index = index
        self.label = label
        self.question = question
        self.context = context
        self.choices = choices
        self.freeText = freeText
        self.recommendation = recommendation
        self.unblocks = unblocks
        self.state = state
    }

    private enum CodingKeys: String, CodingKey {
        case itemId, index, label, question, context, choices, freeText, recommendation, unblocks, state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = c.lenient(String.self, .itemId) ?? ""
        index = c.lenient(Int.self, .index) ?? 0
        label = c.lenient(String.self, .label)
        question = c.lenient(String.self, .question) ?? ""
        context = c.lenient(String.self, .context)
        choices = c.lenientList(String.self, .choices).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        // No choices means the answer has to be typed.
        freeText = (c.lenient(Bool.self, .freeText) ?? true) || choices.isEmpty
        recommendation = c.lenient(String.self, .recommendation)
        unblocks = c.lenient(String.self, .unblocks)
        state = c.lenient(State.self, .state) ?? State()
    }

    /// "Main decision" for index 0, else the agent's label, else "Question N".
    public var displayLabel: String {
        if let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        return index == 0 ? "Main decision" : "Question \(index)"
    }
}

public struct SupervisorQuestionItemsSummary: Decodable, Sendable, Equatable {
    public var total: Int
    public var unanswered: Int
    public var skipped: Int
    public var queued: Int
    public var delivered: Int
    public var failed: Int
    /// unanswered + skipped + failed.
    public var open: Int

    public init(total: Int = 0, unanswered: Int = 0, skipped: Int = 0, queued: Int = 0,
                delivered: Int = 0, failed: Int = 0, open: Int? = nil) {
        self.total = total
        self.unanswered = unanswered
        self.skipped = skipped
        self.queued = queued
        self.delivered = delivered
        self.failed = failed
        self.open = open ?? (unanswered + skipped + failed)
    }

    /// Counted from the items themselves (after a send, before the hub's
    /// next state arrives).
    public init(items: [SupervisorQuestionItem]) {
        func count(_ status: String) -> Int { items.filter { $0.state.status == status }.count }
        self.init(total: items.count, unanswered: count("unanswered"), skipped: count("skipped"),
                  queued: count("queued"), delivered: count("delivered"), failed: count("failed"))
    }

    private enum CodingKeys: String, CodingKey { case total, unanswered, skipped, queued, delivered, failed, open }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let unanswered = c.lenient(Int.self, .unanswered) ?? 0
        let skipped = c.lenient(Int.self, .skipped) ?? 0
        let failed = c.lenient(Int.self, .failed) ?? 0
        self.init(total: c.lenient(Int.self, .total) ?? 0, unanswered: unanswered, skipped: skipped,
                  queued: c.lenient(Int.self, .queued) ?? 0, delivered: c.lenient(Int.self, .delivered) ?? 0,
                  failed: failed, open: c.lenient(Int.self, .open))
    }
}

/// One answer in an `answer_items` request: the chosen choice's text or the
/// owner's typed words, for one item.
public struct SupervisorQuestionItemAnswer: Sendable, Equatable {
    public var itemId: String
    public var answer: String

    public init(itemId: String, answer: String) {
        self.itemId = itemId
        self.answer = answer
    }
}

public struct SupervisorCard: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var questionId: String?
    public var kind: String?
    public var kindLabel: String?
    public var slice: String?
    public var headline: String
    public var needsYou: Bool
    public var decisionHeadline: String?
    public var decisionFact: String?
    public var decisionSource: SupervisorDecisionSource?
    public var decisionAction: SupervisorCardAction?
    public var remainingItemIds: [String]
    public var decisionItems: [FleetDecisionItem]
    public var sessionTitle: String?
    public var summary: String?
    public var brief: SupervisorCardBrief?
    public var suggestedReplies: [String]
    public var canReply: Bool
    public var agentSummary: String?
    public var recommendation: String?
    public var threadKey: String?
    public var threadKeys: [String]
    public var repo: String?
    public var branch: String?
    public var workspace: String?
    public var prRef: String?
    public var prUrl: String?
    public var prNumber: Int?
    public var headSha: String?
    public var ciState: String?
    public var mergeState: String?
    public var noticedAt: Date?
    public var risky: Bool
    public var options: [String]
    public var primaryAction: SupervisorCardAction?
    public var secondaryAction: SupervisorCardAction?
    public var extraActions: [SupervisorCardAction]
    public var prContext: SupervisorPRContext?
    public var recentMessages: [SupervisorRecentMessage]
    public var timeline: [SupervisorTimelineItem]
    public var resources: [SupervisorResource]
    public var openChat: FleetOpenChat?
    public var project: String?
    public var plan: SupervisorSuggestionPlan?
    public var blockingCount: Int
    public var blockingSummary: String?
    public var actorLabel: String?
    public var subchannel: String?
    public var labels: [String]
    /// The four-section decision contract; nil from hubs that predate it.
    public var decisionView: SupervisorDecisionView?
    /// "decision" | "fyi" | ...: an FYI is never an owner ask.
    public var askType: String?
    /// Two or more independent questions in this ask; empty otherwise.
    public var questionItems: [SupervisorQuestionItem]
    public var questionItemsSummary: SupervisorQuestionItemsSummary?

    /// Whether this card is answered question by question. Completions and
    /// FYIs never are, whatever they carry.
    public var hasQuestionWalkthrough: Bool {
        guard questionItems.count >= 2 else { return false }
        if (kind ?? "").lowercased() == "completed" { return false }
        if (askType ?? "").lowercased() == "fyi" { return false }
        return true
    }

    /// The hub's counts, else counted from the items.
    public var questionItemsCounts: SupervisorQuestionItemsSummary {
        questionItemsSummary ?? SupervisorQuestionItemsSummary(items: questionItems)
    }

    public init(id: String, questionId: String? = nil, kind: String? = nil, kindLabel: String? = nil,
                slice: String? = nil, headline: String, needsYou: Bool = true, decisionHeadline: String? = nil,
                decisionFact: String? = nil, decisionSource: SupervisorDecisionSource? = nil,
                decisionAction: SupervisorCardAction? = nil, remainingItemIds: [String] = [], decisionItems: [FleetDecisionItem] = [], sessionTitle: String? = nil,
                summary: String? = nil, brief: SupervisorCardBrief? = nil, suggestedReplies: [String] = [],
                canReply: Bool? = nil, agentSummary: String? = nil, recommendation: String? = nil,
                threadKey: String? = nil, threadKeys: [String] = [], repo: String? = nil, branch: String? = nil,
                workspace: String? = nil, prRef: String? = nil, prUrl: String? = nil, prNumber: Int? = nil,
                headSha: String? = nil, ciState: String? = nil, mergeState: String? = nil, noticedAt: Date? = nil,
                risky: Bool = false, options: [String] = [], primaryAction: SupervisorCardAction? = nil,
                secondaryAction: SupervisorCardAction? = nil, extraActions: [SupervisorCardAction] = [],
                prContext: SupervisorPRContext? = nil, recentMessages: [SupervisorRecentMessage] = [],
                timeline: [SupervisorTimelineItem] = [], resources: [SupervisorResource] = [],
                openChat: FleetOpenChat? = nil, project: String? = nil, plan: SupervisorSuggestionPlan? = nil,
                blockingCount: Int = 0, blockingSummary: String? = nil, actorLabel: String? = nil,
                subchannel: String? = nil, labels: [String] = [],
                decisionView: SupervisorDecisionView? = nil, askType: String? = nil,
                questionItems: [SupervisorQuestionItem] = [],
                questionItemsSummary: SupervisorQuestionItemsSummary? = nil) {
        self.id = id
        self.questionId = questionId
        self.kind = kind
        self.kindLabel = kindLabel
        self.slice = slice
        self.headline = headline
        self.needsYou = needsYou
        self.decisionHeadline = decisionHeadline
        self.decisionFact = decisionFact
        self.decisionSource = decisionSource
        self.decisionAction = decisionAction
        self.remainingItemIds = remainingItemIds
        self.decisionItems = decisionItems
        self.sessionTitle = sessionTitle
        self.summary = summary
        self.brief = brief
        self.suggestedReplies = suggestedReplies
        self.canReply = canReply ?? (threadKey != nil && threadKeys.count <= 1 && kind != "suggestion" && kind != "preference")
        self.agentSummary = agentSummary
        self.recommendation = recommendation
        self.threadKey = threadKey
        self.threadKeys = threadKeys
        self.repo = repo
        self.branch = branch
        self.workspace = workspace
        self.prRef = prRef
        self.prUrl = prUrl
        self.prNumber = prNumber
        self.headSha = headSha
        self.ciState = ciState
        self.mergeState = mergeState
        self.noticedAt = noticedAt
        self.risky = risky
        self.options = options
        self.primaryAction = primaryAction
        self.secondaryAction = secondaryAction
        self.extraActions = extraActions
        self.prContext = prContext
        self.recentMessages = recentMessages
        self.timeline = timeline
        self.resources = resources
        self.openChat = openChat
        self.project = project
        self.plan = plan
        self.blockingCount = blockingCount
        self.blockingSummary = blockingSummary
        self.actorLabel = actorLabel
        self.subchannel = subchannel
        self.labels = labels
        self.decisionView = decisionView
        self.askType = askType
        self.questionItems = questionItems
        self.questionItemsSummary = questionItemsSummary
    }

    private enum CodingKeys: String, CodingKey {
        case id, questionId, kind, kindLabel, slice, headline, needsYou, decisionHeadline, decisionFact, decisionSource, decisionAction, remainingItemIds, decisionItems, sessionTitle, summary, brief, suggestedReplies, canReply, agentSummary, recommendation
        case threadKey, threadKeys, repo, branch, workspace, prRef, prUrl, prNumber, headSha
        case ciState, mergeState, noticedAt, risky, options, primaryAction, secondaryAction, extraActions
        case prContext, recentMessages, timeline, resources, openChat, project, plan
        case blockingCount, blockingSummary, actorLabel, subchannel, labels, decisionView
        case askType, questionItems, questionItemsSummary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        questionId = c.lenient(String.self, .questionId)
        kind = c.lenient(String.self, .kind)
        kindLabel = c.lenient(String.self, .kindLabel)
        slice = c.lenient(String.self, .slice)
        headline = c.lenient(String.self, .headline) ?? "Needs review"
        needsYou = c.lenient(Bool.self, .needsYou) ?? true
        decisionHeadline = c.lenient(String.self, .decisionHeadline)
        decisionFact = c.lenient(String.self, .decisionFact)
        decisionSource = c.lenient(SupervisorDecisionSource.self, .decisionSource)
        decisionAction = c.lenient(SupervisorCardAction.self, .decisionAction)
        remainingItemIds = c.lenientList(String.self, .remainingItemIds)
        decisionItems = c.lenientList(FleetDecisionItem.self, .decisionItems)
        sessionTitle = c.lenient(String.self, .sessionTitle)
        summary = c.lenient(String.self, .summary)
        brief = c.lenient(SupervisorCardBrief.self, .brief)
        suggestedReplies = c.lenientList(String.self, .suggestedReplies)
        agentSummary = c.lenient(String.self, .agentSummary)
        recommendation = c.lenient(String.self, .recommendation)
        threadKey = c.lenient(String.self, .threadKey)
        threadKeys = c.lenientList(String.self, .threadKeys)
        canReply = c.lenient(Bool.self, .canReply) ?? (threadKey != nil && threadKeys.count <= 1 && kind != "suggestion" && kind != "preference")
        repo = c.lenient(String.self, .repo)
        branch = c.lenient(String.self, .branch)
        workspace = c.lenient(String.self, .workspace)
        prRef = c.lenient(String.self, .prRef)
        prUrl = c.lenient(String.self, .prUrl)
        prNumber = c.lenient(Int.self, .prNumber)
        headSha = c.lenient(String.self, .headSha)
        ciState = c.lenient(String.self, .ciState)
        mergeState = c.lenient(String.self, .mergeState)
        noticedAt = c.lenient(Date.self, .noticedAt)
        risky = c.lenient(Bool.self, .risky) ?? false
        options = c.lenientList(String.self, .options)
        primaryAction = c.lenient(SupervisorCardAction.self, .primaryAction)
        secondaryAction = c.lenient(SupervisorCardAction.self, .secondaryAction)
        extraActions = c.lenientList(SupervisorCardAction.self, .extraActions)
        prContext = c.lenient(SupervisorPRContext.self, .prContext)
        recentMessages = c.lenientList(SupervisorRecentMessage.self, .recentMessages)
        timeline = c.lenientList(SupervisorTimelineItem.self, .timeline)
        resources = c.lenientList(SupervisorResource.self, .resources)
        openChat = c.lenient(FleetOpenChat.self, .openChat)
        project = c.lenient(String.self, .project)
        plan = c.lenient(SupervisorSuggestionPlan.self, .plan)
        blockingCount = c.lenient(Int.self, .blockingCount) ?? 0
        blockingSummary = c.lenient(String.self, .blockingSummary)
        actorLabel = c.lenient(String.self, .actorLabel)
        subchannel = c.lenient(String.self, .subchannel)
        labels = c.lenientList(String.self, .labels)
        decisionView = c.lenient(SupervisorDecisionView.self, .decisionView)
        askType = c.lenient(String.self, .askType)
        questionItems = c.lenientList(SupervisorQuestionItem.self, .questionItems)
            .filter { !$0.itemId.isEmpty && !$0.question.isEmpty }
            .sorted { $0.index < $1.index }
        questionItemsSummary = c.lenient(SupervisorQuestionItemsSummary.self, .questionItemsSummary)
    }
}

public struct SupervisorPreferences: Decodable, Sendable, Equatable {
    public var mergePolicy: String
    public var cadence: String
    public var autoSlices: [String]

    public init(mergePolicy: String = "manual_confirm", cadence: String = "balanced", autoSlices: [String] = []) {
        self.mergePolicy = mergePolicy
        self.cadence = cadence
        self.autoSlices = autoSlices
    }

    private enum CodingKeys: String, CodingKey { case mergePolicy, cadence, autoSlices }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mergePolicy = c.lenient(String.self, .mergePolicy) ?? "manual_confirm"
        cadence = c.lenient(String.self, .cadence) ?? "balanced"
        if let sliceModes = c.lenient([String: String].self, .autoSlices) {
            autoSlices = sliceModes.compactMap { key, mode in mode == "auto" ? key : nil }.sorted()
        } else {
            autoSlices = c.lenientList(String.self, .autoSlices)
        }
    }
}

public struct SupervisorAutonomousAction: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var slice: String?
    public var sliceLabel: String?
    public var summary: String?
    public var threadKey: String?
    public var at: Date?
    public var vetoed: Bool
    public var canVeto: Bool

    public init(id: String, slice: String? = nil, sliceLabel: String? = nil, summary: String? = nil,
                threadKey: String? = nil, at: Date? = nil, vetoed: Bool = false, canVeto: Bool? = nil) {
        self.id = id
        self.slice = slice
        self.sliceLabel = sliceLabel
        self.summary = summary
        self.threadKey = threadKey
        self.at = at
        self.vetoed = vetoed
        self.canVeto = canVeto ?? (slice != nil && !vetoed)
    }

    private enum CodingKeys: String, CodingKey {
        case id, slice, sliceLabel, summary, threadKey, at, vetoed, reverted, canVeto
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        let decodedSlice = c.lenient(String.self, .slice)
        slice = decodedSlice
        sliceLabel = c.lenient(String.self, .sliceLabel)
        summary = c.lenient(String.self, .summary)
        threadKey = c.lenient(String.self, .threadKey)
        at = c.lenient(Date.self, .at)
        let isVetoed = c.lenient(Bool.self, .vetoed) ?? c.lenient(Bool.self, .reverted) ?? false
        vetoed = isVetoed
        canVeto = c.lenient(Bool.self, .canVeto) ?? (decodedSlice != nil && !isVetoed)
    }
}

public struct SupervisorAutonomy: Decodable, Sendable, Equatable {
    public var handledCount: Int
    public var totalDecisions: Int
    public var autonomousPercent: Int
    public var recentActions: [SupervisorAutonomousAction]

    public init(handledCount: Int = 0, totalDecisions: Int = 0, autonomousPercent: Int = 0,
                recentActions: [SupervisorAutonomousAction] = []) {
        self.handledCount = handledCount
        self.totalDecisions = totalDecisions
        self.autonomousPercent = autonomousPercent
        self.recentActions = recentActions
    }

    private enum CodingKeys: String, CodingKey {
        case handledCount, handledToday, totalDecisions, autonomousPercent, autonomyPercent, recentActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let handled = c.lenient(Int.self, .handledCount) ?? c.lenient(Int.self, .handledToday) ?? 0
        handledCount = handled
        totalDecisions = c.lenient(Int.self, .totalDecisions) ?? handled
        autonomousPercent = c.lenient(Int.self, .autonomousPercent) ?? c.lenient(Int.self, .autonomyPercent) ?? 0
        recentActions = c.lenientList(SupervisorAutonomousAction.self, .recentActions)
    }
}

public struct SupervisorActiveSummary: Decodable, Sendable, Equatable {
    public var running: Int
    public var waitingCi: Int
    public var needsYou: Int
    public var total: Int

    public init(running: Int = 0, waitingCi: Int = 0, needsYou: Int = 0, total: Int = 0) {
        self.running = running
        self.waitingCi = waitingCi
        self.needsYou = needsYou
        self.total = total
    }

    private enum CodingKeys: String, CodingKey { case running, waitingCi, needsYou, total }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = c.lenient(Int.self, .running) ?? 0
        waitingCi = c.lenient(Int.self, .waitingCi) ?? 0
        needsYou = c.lenient(Int.self, .needsYou) ?? 0
        total = c.lenient(Int.self, .total) ?? 0
    }
}

public struct FleetCardActResult: Decodable, Sendable, Equatable {
    public var ok: Bool
    public var status: String?
    public var reason: String?
    public var message: String?
    public var delivery: FleetDelivery?
    public var state: FleetState?
    /// "answer_items" | "review_items" | "answer" | ...
    public var kind: String?
    /// `answer_items`: every item of the ask with its updated state.
    public var items: [SupervisorQuestionItem]
    // An answer's or reply's outcome (see FleetDelivery.outcome).
    public var outcome: String?

    public init(ok: Bool = false, status: String? = nil, reason: String? = nil, message: String? = nil,
                delivery: FleetDelivery? = nil, state: FleetState? = nil, kind: String? = nil,
                items: [SupervisorQuestionItem] = [], outcome: String? = nil) {
        self.ok = ok
        self.status = status
        self.reason = reason
        self.message = message
        self.delivery = delivery
        self.state = state
        self.kind = kind
        self.items = items
        self.outcome = outcome
    }

    private static let failureStatuses: Set<String> = [
        "halted", "merge_blocked", "ci_failed", "sha_changed", "not_mergeable", "blocked", "failed", "closed"
    ]

    private enum CodingKeys: String, CodingKey { case result, ok, status, reason, detail, message, delivery, state, kind, items, outcome }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let inner = try? c.nestedContainer(keyedBy: CodingKeys.self, forKey: .result)
        let decodedStatus = inner?.lenient(String.self, .status) ?? c.lenient(String.self, .status)
        let decodedOk = inner?.lenient(Bool.self, .ok) ?? c.lenient(Bool.self, .ok)
        status = decodedStatus
        reason = inner?.lenient(String.self, .reason) ?? c.lenient(String.self, .reason)
        message = inner?.lenient(String.self, .detail)
            ?? inner?.lenient(String.self, .message)
            ?? c.lenient(String.self, .detail)
            ?? c.lenient(String.self, .message)
        delivery = inner?.lenient(FleetDelivery.self, .delivery) ?? c.lenient(FleetDelivery.self, .delivery)
        state = c.lenient(FleetState.self, .state) ?? inner?.lenient(FleetState.self, .state)
        kind = inner?.lenient(String.self, .kind) ?? c.lenient(String.self, .kind)
        let innerItems = inner?.lenientList(SupervisorQuestionItem.self, .items) ?? []
        items = (innerItems.isEmpty ? c.lenientList(SupervisorQuestionItem.self, .items) : innerItems)
            .filter { !$0.itemId.isEmpty }
        outcome = inner?.lenient(String.self, .outcome) ?? c.lenient(String.self, .outcome) ?? delivery?.outcome
        ok = decodedOk ?? !(decodedStatus.map { Self.failureStatuses.contains($0) } ?? false)
    }
}

public struct FleetSearchHit: Decodable, Sendable, Equatable, Identifiable {
    public var key: String
    public var title: String?
    public var workspace: String?
    public var repo: String?
    public var branch: String?
    public var state: String?
    public var health: String?
    public var snippet: String?
    public var prRef: String?
    public var score: Double?
    public var live: Bool

    public var id: String { key }

    public init(key: String, title: String? = nil, workspace: String? = nil, repo: String? = nil,
                branch: String? = nil, state: String? = nil, health: String? = nil, snippet: String? = nil,
                prRef: String? = nil, score: Double? = nil, live: Bool = false) {
        self.key = key
        self.title = title
        self.workspace = workspace
        self.repo = repo
        self.branch = branch
        self.state = state
        self.health = health
        self.snippet = snippet
        self.prRef = prRef
        self.score = score
        self.live = live
    }

    private enum CodingKeys: String, CodingKey {
        case key, title, workspace, repo, branch, state, health, snippet, prRef, score, live
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(String.self, .key) ?? ""
        title = c.lenient(String.self, .title)
        workspace = c.lenient(String.self, .workspace)
        repo = c.lenient(String.self, .repo)
        branch = c.lenient(String.self, .branch)
        state = c.lenient(String.self, .state)
        health = c.lenient(String.self, .health)
        snippet = c.lenient(String.self, .snippet)
        prRef = c.lenient(String.self, .prRef)
        score = c.lenient(Double.self, .score)
        live = c.lenient(Bool.self, .live) ?? false
    }
}

public struct FleetSearchResponse: Decodable, Sendable, Equatable {
    public var query: String?
    public var results: [FleetSearchHit]
    public var total: Int

    private enum CodingKeys: String, CodingKey { case query, results, total }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = c.lenient(String.self, .query)
        results = c.lenientList(FleetSearchHit.self, .results)
        total = c.lenient(Int.self, .total) ?? results.count
    }
}

public struct FleetBatchCardsResult: Decodable, Sendable, Equatable {
    public struct Outcome: Decodable, Sendable, Equatable {
        public var ok: Bool
        public var total: Int
        public var succeeded: Int
        public var halted: Int
        public var detail: String?

        private enum CodingKeys: String, CodingKey { case ok, total, succeeded, halted, detail }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ok = c.lenient(Bool.self, .ok) ?? true
            total = c.lenient(Int.self, .total) ?? 0
            succeeded = c.lenient(Int.self, .succeeded) ?? 0
            halted = c.lenient(Int.self, .halted) ?? 0
            detail = c.lenient(String.self, .detail)
        }
    }

    public var result: Outcome?
    public var state: FleetState?

    private enum CodingKeys: String, CodingKey { case result, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        result = c.lenient(Outcome.self, .result)
        state = c.lenient(FleetState.self, .state)
    }
}

public struct FleetHierarchyCounts: Decodable, Sendable, Equatable {
    public var running: Int
    public var idle: Int
    public var sleeping: Int
    public var total: Int

    private enum CodingKeys: String, CodingKey { case running, idle, sleeping, total }

    public init(running: Int = 0, idle: Int = 0, sleeping: Int = 0, total: Int = 0) {
        self.running = running
        self.idle = idle
        self.sleeping = sleeping
        self.total = total
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = c.lenient(Int.self, .running) ?? 0
        idle = c.lenient(Int.self, .idle) ?? 0
        sleeping = c.lenient(Int.self, .sleeping) ?? 0
        total = c.lenient(Int.self, .total) ?? 0
    }
}

public struct FleetHierarchySession: Decodable, Sendable, Equatable, Identifiable {
    public var id: String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "\(host ?? "local"):\(title ?? "session")" : trimmed
    }
    public var key: String
    public var title: String?
    public var workspace: String?
    public var theme: String?
    public var state: String?
    public var host: String?
    public var prRefs: [String]
    public var snippet: String?
    public var needsYouCount: Int

    private enum CodingKeys: String, CodingKey {
        case key, title, workspace, theme, state, host, prRefs, snippet, needsYouCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(String.self, .key) ?? ""
        title = c.lenient(String.self, .title)
        workspace = c.lenient(String.self, .workspace)
        theme = c.lenient(String.self, .theme)
        state = c.lenient(String.self, .state)
        host = c.lenient(String.self, .host)
        prRefs = c.lenientList(String.self, .prRefs)
        snippet = c.lenient(String.self, .snippet)
        needsYouCount = c.lenient(Int.self, .needsYouCount) ?? 0
    }
}

public struct FleetThemeGroup: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var labelPath: String?
    public var source: String?
    public var counts: FleetHierarchyCounts
    public var needsYouCount: Int
    public var prRefs: [String]
    public var sessions: [FleetHierarchySession]

    private enum CodingKeys: String, CodingKey {
        case id, name, labelPath, source, counts, needsYouCount, prRefs, sessions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let resolvedName = c.lenient(String.self, .name) ?? "General"
        id = c.lenient(String.self, .id) ?? resolvedName.lowercased()
        name = resolvedName
        labelPath = c.lenient(String.self, .labelPath)
        source = c.lenient(String.self, .source)
        counts = c.lenient(FleetHierarchyCounts.self, .counts) ?? FleetHierarchyCounts()
        needsYouCount = c.lenient(Int.self, .needsYouCount) ?? 0
        prRefs = c.lenientList(String.self, .prRefs)
        sessions = c.lenientList(FleetHierarchySession.self, .sessions)
    }
}

public struct FleetProjectGroup: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var supervisorTitle: String
    public var repo: String?
    public var counts: FleetHierarchyCounts
    public var needsYouCount: Int
    public var themes: [FleetThemeGroup]

    private enum CodingKeys: String, CodingKey {
        case id, name, supervisorTitle, repo, counts, needsYouCount, themes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let resolvedName = c.lenient(String.self, .name) ?? "Workspace"
        id = c.lenient(String.self, .id) ?? resolvedName.lowercased()
        name = resolvedName
        supervisorTitle = c.lenient(String.self, .supervisorTitle) ?? "\(resolvedName) Supervisor"
        repo = c.lenient(String.self, .repo)
        counts = c.lenient(FleetHierarchyCounts.self, .counts) ?? FleetHierarchyCounts()
        needsYouCount = c.lenient(Int.self, .needsYouCount) ?? 0
        themes = c.lenientList(FleetThemeGroup.self, .themes)
    }
}

public struct FleetHierarchyResponse: Decodable, Sendable, Equatable {
    public var totalProjects: Int
    public var totalThemes: Int
    public var totalSessions: Int
    public var projects: [FleetProjectGroup]

    private enum CodingKeys: String, CodingKey {
        case totalProjects, totalThemes, totalSessions, projects
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = c.lenientList(FleetProjectGroup.self, .projects)
        totalProjects = c.lenient(Int.self, .totalProjects) ?? projects.count
        totalThemes = c.lenient(Int.self, .totalThemes) ?? 0
        totalSessions = c.lenient(Int.self, .totalSessions) ?? 0
    }
}

public struct FleetDispatchGoalResponse: Decodable, Sendable, Equatable {
    public struct MatchedSession: Decodable, Sendable, Equatable {
        public var key: String
        public var title: String?
        public var theme: String?
        public var state: String?
        public var confidence: Double?

        private enum CodingKeys: String, CodingKey { case key, title, theme, state, confidence }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = c.lenient(String.self, .key) ?? ""
            title = c.lenient(String.self, .title)
            theme = c.lenient(String.self, .theme)
            state = c.lenient(String.self, .state)
            confidence = c.lenient(Double.self, .confidence)
        }
    }

    public struct CreatedSession: Decodable, Sendable, Equatable {
        public var key: String
        public var title: String?
        public var host: String?
        public var cwd: String?

        private enum CodingKeys: String, CodingKey { case key, title, host, cwd }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = c.lenient(String.self, .key) ?? ""
            title = c.lenient(String.self, .title)
            host = c.lenient(String.self, .host)
            cwd = c.lenient(String.self, .cwd)
        }
    }

    public struct Outcome: Decodable, Sendable, Equatable {
        public var ok: Bool
        public var status: String
        public var message: String?
        public var inferredTheme: String?
        public var matchedSession: MatchedSession?
        public var createdSession: CreatedSession?

        private enum CodingKeys: String, CodingKey {
            case ok, status, message, inferredTheme, matchedSession, createdSession
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let resolvedStatus = c.lenient(String.self, .status) ?? "done"
            status = resolvedStatus
            ok = c.lenient(Bool.self, .ok) ?? (resolvedStatus != "blocked")
            message = c.lenient(String.self, .message)
            inferredTheme = c.lenient(String.self, .inferredTheme)
            matchedSession = c.lenient(MatchedSession.self, .matchedSession)
            createdSession = c.lenient(CreatedSession.self, .createdSession)
        }
    }

    public var result: Outcome?
    public var state: FleetState?

    private enum CodingKeys: String, CodingKey { case result, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        result = c.lenient(Outcome.self, .result)
        state = c.lenient(FleetState.self, .state)
    }
}

public struct FleetClaimedSession: Decodable, Sendable, Equatable {
    public var key: String
    public var title: String?
    public var workspace: String?
    public var cwd: String?
    public var provider: String?
    public var model: String?

    private enum CodingKeys: String, CodingKey { case key, title, workspace, cwd, provider, model }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(String.self, .key) ?? ""
        title = c.lenient(String.self, .title)
        workspace = c.lenient(String.self, .workspace)
        cwd = c.lenient(String.self, .cwd)
        provider = c.lenient(String.self, .provider)
        model = c.lenient(String.self, .model)
    }
}

public struct FleetTaskClaimResponse: Decodable, Sendable {
    public var task: TaskRecord?
    public var session: FleetClaimedSession?
    public var state: FleetState?

    private enum CodingKeys: String, CodingKey { case task, session, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = c.lenient(TaskRecord.self, .task)
        session = c.lenient(FleetClaimedSession.self, .session)
        state = c.lenient(FleetState.self, .state)
    }
}
