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

public struct FleetState: Decodable, Sendable, Equatable {
    public var mode: String?
    public var enabled: Bool
    public var running: Bool
    public var lastTickAt: Date?
    public var lastError: JSONValue?
    public var snapshot: FleetSnapshot?
    public var questions: [FleetQuestion]
    public var actions: [FleetAction]
    public var cards: [SupervisorCard]
    public var preferences: SupervisorPreferences?
    public var autonomy: SupervisorAutonomy?
    public var activeSummary: SupervisorActiveSummary?
    public var catchUpSummary: String?

    public var lastErrorText: String? { lastError?.fleetText }

    public init(mode: String? = nil, enabled: Bool = false, running: Bool = false, lastTickAt: Date? = nil,
                lastError: JSONValue? = nil, snapshot: FleetSnapshot? = nil,
                questions: [FleetQuestion] = [], actions: [FleetAction] = [],
                cards: [SupervisorCard] = [], preferences: SupervisorPreferences? = nil,
                autonomy: SupervisorAutonomy? = nil, activeSummary: SupervisorActiveSummary? = nil,
                catchUpSummary: String? = nil) {
        self.mode = mode
        self.enabled = enabled
        self.running = running
        self.lastTickAt = lastTickAt
        self.lastError = lastError
        self.snapshot = snapshot
        self.questions = questions
        self.actions = actions
        self.cards = cards
        self.preferences = preferences
        self.autonomy = autonomy
        self.activeSummary = activeSummary
        self.catchUpSummary = catchUpSummary
    }

    private enum CodingKeys: String, CodingKey {
        case mode, enabled, running, lastTickAt, lastError, snapshot, questions, actions
        case cards, preferences, autonomy, activeSummary, catchUpSummary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = c.lenient(String.self, .mode)
        enabled = c.lenient(Bool.self, .enabled) ?? false
        running = c.lenient(Bool.self, .running) ?? false
        lastTickAt = c.lenient(Date.self, .lastTickAt)
        lastError = c.lenient(JSONValue.self, .lastError)
        snapshot = c.lenient(FleetSnapshot.self, .snapshot)
        questions = c.lenientList(FleetQuestion.self, .questions)
        actions = c.lenientList(FleetAction.self, .actions)
        cards = c.lenientList(SupervisorCard.self, .cards)
        preferences = c.lenient(SupervisorPreferences.self, .preferences)
        autonomy = c.lenient(SupervisorAutonomy.self, .autonomy)
        activeSummary = c.lenient(SupervisorActiveSummary.self, .activeSummary)
        catchUpSummary = c.lenient(String.self, .catchUpSummary)
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
}

public struct FleetThread: Decodable, Sendable, Equatable, Identifiable {
    public var key: String
    public var kind: String?
    public var title: String?
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

    public var id: String { key }

    public init(key: String, kind: String? = nil, title: String? = nil, workspace: String? = nil, repo: String? = nil,
                branch: String? = nil, agentStatus: String? = nil, state: String? = nil, health: String? = nil,
                reason: String? = nil, blockers: [String] = [], pr: FleetPR? = nil, lastActivityAt: Date? = nil,
                lastAgentText: String? = nil, error: FleetThreadError? = nil, live: Bool = false,
                decision: FleetDecision? = nil) {
        self.key = key
        self.kind = kind
        self.title = title
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
    }

    private enum CodingKeys: String, CodingKey {
        case key, kind, title, workspace, repo, branch, agentStatus, state, health, reason, blockers, pr
        case lastActivityAt, lastAgentText, error, live, decision
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(String.self, .key) ?? ""
        kind = c.lenient(String.self, .kind)
        title = c.lenient(String.self, .title)
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
    }
}

// A thread whose PR the supervisor could not read still carries its ref, with
// url/state null -- the same partial shape buildSnapshot emits.
public struct FleetPR: Decodable, Sendable, Equatable {
    public var ref: String?
    public var url: String?
    public var state: String?
    public var title: String?
    public var ci: FleetCI?
    public var unresolvedThreads: Int?

    public init(ref: String? = nil, url: String? = nil, state: String? = nil, title: String? = nil,
                ci: FleetCI? = nil, unresolvedThreads: Int? = nil) {
        self.ref = ref
        self.url = url
        self.state = state
        self.title = title
        self.ci = ci
        self.unresolvedThreads = unresolvedThreads
    }

    private enum CodingKeys: String, CodingKey { case ref, url, state, title, ci, unresolvedThreads }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = c.lenient(String.self, .ref)
        url = c.lenient(String.self, .url)
        state = c.lenient(String.self, .state)
        title = c.lenient(String.self, .title)
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

    public init(id: String, title: String? = nil, body: String? = nil, options: [String] = [], kind: String? = nil,
                threadKey: String? = nil, threadKeys: [String]? = nil, prRef: String? = nil, createdAt: Date? = nil) {
        self.id = id
        self.title = title
        self.body = body
        self.options = options
        self.kind = kind
        self.threadKey = threadKey
        self.threadKeys = threadKeys
        self.prRef = prRef
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, body, options, kind, threadKey, threadKeys, prRef, createdAt
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

    public init(status: String? = nil, route: String? = nil, detail: String? = nil) {
        self.status = status
        self.route = route
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey { case status, route, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(String.self, .status)
        route = c.lenient(String.self, .route)
        detail = c.lenient(String.self, .detail)
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

    public init(op: String, label: String, value: String? = nil, destructive: Bool = false) {
        self.op = op
        self.label = label
        self.value = value
        self.destructive = destructive
    }

    private enum CodingKeys: String, CodingKey { case op, label, value, destructive }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        op = c.lenient(String.self, .op) ?? ""
        label = c.lenient(String.self, .label) ?? ""
        value = c.lenient(String.self, .value)
        destructive = c.lenient(Bool.self, .destructive) ?? false
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

    public var id: String { "\(kind)-\(label)-\(url ?? threadKey ?? "")" }

    public init(kind: String, label: String, url: String? = nil, threadKey: String? = nil) {
        self.kind = kind
        self.label = label
        self.url = url
        self.threadKey = threadKey
    }

    private enum CodingKeys: String, CodingKey { case kind, label, url, threadKey }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(String.self, .kind) ?? ""
        label = c.lenient(String.self, .label) ?? ""
        url = c.lenient(String.self, .url)
        threadKey = c.lenient(String.self, .threadKey)
    }
}

public struct SupervisorCard: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var questionId: String?
    public var kind: String?
    public var kindLabel: String?
    public var slice: String?
    public var headline: String
    public var summary: String?
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
    public var timeline: [SupervisorTimelineItem]
    public var resources: [SupervisorResource]

    public init(id: String, questionId: String? = nil, kind: String? = nil, kindLabel: String? = nil,
                slice: String? = nil, headline: String, summary: String? = nil, recommendation: String? = nil,
                threadKey: String? = nil, threadKeys: [String] = [], repo: String? = nil, branch: String? = nil,
                workspace: String? = nil, prRef: String? = nil, prUrl: String? = nil, prNumber: Int? = nil,
                headSha: String? = nil, ciState: String? = nil, mergeState: String? = nil, noticedAt: Date? = nil,
                risky: Bool = false, options: [String] = [], primaryAction: SupervisorCardAction? = nil,
                secondaryAction: SupervisorCardAction? = nil, timeline: [SupervisorTimelineItem] = [],
                resources: [SupervisorResource] = []) {
        self.id = id
        self.questionId = questionId
        self.kind = kind
        self.kindLabel = kindLabel
        self.slice = slice
        self.headline = headline
        self.summary = summary
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
        self.timeline = timeline
        self.resources = resources
    }

    private enum CodingKeys: String, CodingKey {
        case id, questionId, kind, kindLabel, slice, headline, summary, recommendation
        case threadKey, threadKeys, repo, branch, workspace, prRef, prUrl, prNumber, headSha
        case ciState, mergeState, noticedAt, risky, options, primaryAction, secondaryAction
        case timeline, resources
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        questionId = c.lenient(String.self, .questionId)
        kind = c.lenient(String.self, .kind)
        kindLabel = c.lenient(String.self, .kindLabel)
        slice = c.lenient(String.self, .slice)
        headline = c.lenient(String.self, .headline) ?? "Needs review"
        summary = c.lenient(String.self, .summary)
        recommendation = c.lenient(String.self, .recommendation)
        threadKey = c.lenient(String.self, .threadKey)
        threadKeys = c.lenientList(String.self, .threadKeys)
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
        timeline = c.lenientList(SupervisorTimelineItem.self, .timeline)
        resources = c.lenientList(SupervisorResource.self, .resources)
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
        autoSlices = c.lenientList(String.self, .autoSlices)
    }
}

public struct SupervisorAutonomousAction: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var slice: String?
    public var summary: String?
    public var threadKey: String?
    public var at: Date?
    public var vetoed: Bool

    public init(id: String, slice: String? = nil, summary: String? = nil, threadKey: String? = nil,
                at: Date? = nil, vetoed: Bool = false) {
        self.id = id
        self.slice = slice
        self.summary = summary
        self.threadKey = threadKey
        self.at = at
        self.vetoed = vetoed
    }

    private enum CodingKeys: String, CodingKey { case id, slice, summary, threadKey, at, vetoed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        slice = c.lenient(String.self, .slice)
        summary = c.lenient(String.self, .summary)
        threadKey = c.lenient(String.self, .threadKey)
        at = c.lenient(Date.self, .at)
        vetoed = c.lenient(Bool.self, .vetoed) ?? false
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
        case handledCount, totalDecisions, autonomousPercent, recentActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handledCount = c.lenient(Int.self, .handledCount) ?? 0
        totalDecisions = c.lenient(Int.self, .totalDecisions) ?? 0
        autonomousPercent = c.lenient(Int.self, .autonomousPercent) ?? 0
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
    public var message: String?
    public var delivery: FleetDelivery?
    public var state: FleetState?

    public init(ok: Bool = false, status: String? = nil, message: String? = nil,
                delivery: FleetDelivery? = nil, state: FleetState? = nil) {
        self.ok = ok
        self.status = status
        self.message = message
        self.delivery = delivery
        self.state = state
    }

    private enum CodingKeys: String, CodingKey { case ok, status, message, delivery, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        status = c.lenient(String.self, .status)
        message = c.lenient(String.self, .message)
        delivery = c.lenient(FleetDelivery.self, .delivery)
        state = c.lenient(FleetState.self, .state)
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
