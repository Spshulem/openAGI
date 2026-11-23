import Foundation

// Wire shapes for the local daemon's /fleet/api/* routes (src/fleet/routes.js).
//
// Same version-skew rules as BriefModels: the app routinely talks to a daemon
// of another version, so a renamed or retyped field costs that FIELD, and one
// question this build can't parse costs that QUESTION, never the whole state.

/// Decodes `T`, or nothing at all. See BriefModels' twin for why array
/// elements are wrapped in this.
private struct Lossy<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// One open "needs you" question from the coding-agent supervisor.
struct FleetSuggestionIssueDraft: Decodable, Equatable {
  let title: String?
  let body: String?
}

struct FleetSuggestionPlan: Decodable, Equatable {
  let remedy: String?
  let label: String?
  let nextAction: String?
  let acceptance: String?
  let issueDraft: FleetSuggestionIssueDraft?
}

struct FleetWorkspaceEntry: Decodable, Equatable, Identifiable {
  struct Target: Decodable, Equatable {
    let serverId: String?
    let hostLabel: String?
    let cwd: String?
  }

  let id: String
  let name: String
  let repo: String?
  let defaultTarget: Target?
}

struct FleetHierarchySession: Decodable, Equatable, Identifiable {
  let key: String
  let title: String?
  let host: String?
  let cwd: String?
  let state: String?
  let lastActivityAt: String?
  let theme: String?
  let themeId: String?
  var id: String { key }
}

struct FleetHierarchyTheme: Decodable, Equatable, Identifiable {
  struct Counts: Decodable, Equatable {
    let running: Int?
    let idle: Int?
    let sleeping: Int?
    let total: Int?
  }

  let id: String
  let name: String
  let source: String?
  let counts: Counts?
  let needsYouCount: Int?
  let sessions: [FleetHierarchySession]

  enum CodingKeys: String, CodingKey { case id, name, source, counts, needsYouCount, sessions }

  init(id: String, name: String, source: String? = nil, counts: Counts? = nil, needsYouCount: Int? = nil, sessions: [FleetHierarchySession] = []) {
    self.id = id
    self.name = name
    self.source = source
    self.counts = counts
    self.needsYouCount = needsYouCount
    self.sessions = sessions
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
    name = (try? c.decode(String.self, forKey: .name)) ?? id
    source = try? c.decodeIfPresent(String.self, forKey: .source)
    counts = try? c.decodeIfPresent(Counts.self, forKey: .counts)
    needsYouCount = try? c.decodeIfPresent(Int.self, forKey: .needsYouCount)
    sessions = ((try? c.decodeIfPresent([Lossy<FleetHierarchySession>].self, forKey: .sessions)) ?? []).compactMap(\.value)
  }
}

struct FleetHierarchyProject: Decodable, Equatable, Identifiable {
  struct Counts: Decodable, Equatable {
    let running: Int?
    let idle: Int?
    let sleeping: Int?
    let total: Int?
  }

  let id: String
  let name: String
  let repo: String?
  let counts: Counts?
  let needsYouCount: Int?
  let themes: [FleetHierarchyTheme]

  enum CodingKeys: String, CodingKey { case id, name, repo, counts, needsYouCount, themes }

  init(id: String, name: String, repo: String? = nil, counts: Counts? = nil, needsYouCount: Int? = nil, themes: [FleetHierarchyTheme] = []) {
    self.id = id
    self.name = name
    self.repo = repo
    self.counts = counts
    self.needsYouCount = needsYouCount
    self.themes = themes
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
    name = (try? c.decode(String.self, forKey: .name)) ?? id
    repo = try? c.decodeIfPresent(String.self, forKey: .repo)
    counts = try? c.decodeIfPresent(Counts.self, forKey: .counts)
    needsYouCount = try? c.decodeIfPresent(Int.self, forKey: .needsYouCount)
    themes = ((try? c.decodeIfPresent([Lossy<FleetHierarchyTheme>].self, forKey: .themes)) ?? []).compactMap(\.value)
  }
}

struct FleetHierarchyResponse: Decodable, Equatable {
  let projects: [FleetHierarchyProject]

  enum CodingKeys: String, CodingKey { case projects }

  init(projects: [FleetHierarchyProject] = []) {
    self.projects = projects
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    projects = ((try? c.decodeIfPresent([Lossy<FleetHierarchyProject>].self, forKey: .projects)) ?? []).compactMap(\.value)
  }
}

struct FleetDecisionSource: Decodable, Equatable {
  let questionId: String?
  let threadKey: String?
  let threadKeys: [String]
  let app: String?
  let cardId: String?
  let itemId: String?

  enum CodingKeys: String, CodingKey { case questionId, threadKey, threadKeys, app, cardId, itemId }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    questionId = try? c.decodeIfPresent(String.self, forKey: .questionId)
    threadKey = try? c.decodeIfPresent(String.self, forKey: .threadKey)
    threadKeys = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .threadKeys)) ?? []).compactMap { $0.value }
    app = try? c.decodeIfPresent(String.self, forKey: .app)
    cardId = try? c.decodeIfPresent(String.self, forKey: .cardId)
    itemId = try? c.decodeIfPresent(String.self, forKey: .itemId)
  }
}

struct FleetCardAction: Decodable, Equatable {
  let op: String?
  let label: String?
  let value: String?

  enum CodingKeys: String, CodingKey { case op, label, value }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    op = try? c.decodeIfPresent(String.self, forKey: .op)
    label = try? c.decodeIfPresent(String.self, forKey: .label)
    value = try? c.decodeIfPresent(String.self, forKey: .value)
  }
}

struct FleetDecisionItem: Decodable, Equatable, Identifiable {
  let itemId: String?
  let source: FleetDecisionSource?
  let headline: String
  let options: [String]
  let multiSelect: Bool
  let freeText: Bool
  let active: Bool
  var id: String { itemId ?? headline }

  enum CodingKeys: String, CodingKey { case itemId, source, headline, options, multiSelect, freeText, active }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    itemId = try? c.decodeIfPresent(String.self, forKey: .itemId)
    source = try? c.decodeIfPresent(FleetDecisionSource.self, forKey: .source)
    headline = (try? c.decodeIfPresent(String.self, forKey: .headline)) ?? "Owner decision"
    options = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .options)) ?? []).compactMap { $0.value }
    multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
    freeText = (try? c.decodeIfPresent(Bool.self, forKey: .freeText)) ?? false
    active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? false
  }
}

struct FleetQuestion: Decodable, Equatable, Identifiable {
  let id: String
  let kind: String?
  let title: String
  let body: String
  /// The fixed answers the supervisor offers. "dismiss" is dropped here: the
  /// row has its own Dismiss button, and a second one would be the same action.
  let options: [String]
  let threadKey: String?
  let threadKeys: [String]
  let prRef: String?
  let reviewReason: String?
  let reviewCategory: String?
  let pinned: Bool
  let createdAt: String?
  let needsYou: Bool
  let decisionHeadline: String?
  let decisionFact: String?
  let decisionSource: FleetDecisionSource?
  let decisionAction: FleetCardAction?
  let remainingItemIds: [String]
  let decisionItems: [FleetDecisionItem]
  /// When the agent asked, else when the supervisor first asked the owner.
  let askedAt: String?
  /// The chat it is about: "remote-dev · Remote dev setup (Conductor)".
  let chatLabel: String?
  /// "here" or "agent app". Nil from a daemon before it: the options decide.
  let answerIn: String?
  let openChat: FleetOpenChat?
  /// A grouped question names each of its chats.
  let chats: [FleetOpenChat]
  /// Merge, production, release, deploy, delete, force-push: the full text
  /// shows before any button.
  let risky: Bool
  /// The agent message the ask came from (untrusted, redacted).
  let askContext: String?
  /// The hub takes a typed reply for it (POST /fleet/api/questions/:id
  /// { reply }). False from a hub before it.
  var canReply: Bool = false
  let project: String?
  let plan: FleetSuggestionPlan?
  let clarificationAnswer: String?
  let blockingCount: Int
  let blockingSummary: String?
  let actorLabel: String?
  let subchannel: String?
  let labels: [String]

  enum CodingKeys: String, CodingKey {
    case id, kind, title, body, options, threadKey, threadKeys, prRef, reviewReason, reviewCategory, pinned, createdAt, needsYou, decisionHeadline, decisionFact, decisionSource, decisionAction, remainingItemIds, decisionItems
    case askedAt, chatLabel, answerIn, openChat, chats, risky, askContext, canReply, project, meta
    case blockingCount, blockingSummary, actorLabel, subchannel, labels
  }

  private enum MetaKeys: String, CodingKey { case plan, clarification }
  private enum ClarificationKeys: String, CodingKey { case answer }

  /// Why the supervisor's review kept it, or the close the owner overrode
  /// with Reopen. Same wording as the /fleet page.
  var reviewNote: String? {
    guard let reason = reviewReason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else {
      return nil
    }
    if pinned, let category = reviewCategory, category != "live" {
      return "You reopened it. The supervisor had said: \(reason)"
    }
    return "Supervisor: \(reason)"
  }
}

extension FleetQuestion {
  /// Options the owner can tap. "open thread" is left out: the supervisor
  /// can't carry it to the agent and always hands it back.
  var isClarificationQuestion: Bool {
    kind == "suggestion" && options.contains("Answer question")
  }

  var tappableOptions: [String] { options.filter { $0 != Self.openThread } }

  var displayAskContext: String? {
    guard let text = askContext?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    return risky ? text : FleetThreadSummary.tail(text, FleetThreadSummary.excerptMax)
  }

  /// True when the answer has to be typed in the agent's own app.
  var answersInThread: Bool { answerIn.map { $0 == "agent app" } ?? options.contains(Self.openThread) }

  /// "asked 3h ago": the agent's ask time, else the question's own.
  var askedTime: String? { askedAt ?? createdAt }

  /// Every chat the question is about, the one it names first.
  var allChats: [FleetOpenChat] {
    if !chats.isEmpty { return chats }
    return openChat.map { [$0] } ?? []
  }

  static let openThread = "open thread"

  /// "on it" -> "On it" for the supervisor's own fixed answers. An agent's
  /// own choices stay exactly as the agent wrote them (branch names, paths).
  func label(for option: String) -> String {
    guard kind != "agent-ask", let first = option.first else { return option }
    return first.uppercased() + option.dropFirst()
  }
}

/// What the last answer or dismissal of one question did, shown in its row.
struct FleetNote: Equatable {
  let text: String
  let isError: Bool
}

// init(from:) in an extension keeps the synthesized memberwise init.
extension FleetQuestion {
  /// Only `id` is required: it is the one thing the client cannot invent.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try? c.decodeIfPresent(String.self, forKey: .kind)
    title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "(untitled)"
    body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
    let rawOptions = (try? c.decodeIfPresent([Lossy<String>].self, forKey: .options)) ?? []
    options = rawOptions.compactMap { $0.value }.filter { !$0.isEmpty && $0 != "dismiss" }
    threadKey = try? c.decodeIfPresent(String.self, forKey: .threadKey)
    threadKeys = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .threadKeys)) ?? []).compactMap { $0.value }
    prRef = try? c.decodeIfPresent(String.self, forKey: .prRef)
    reviewReason = try? c.decodeIfPresent(String.self, forKey: .reviewReason)
    reviewCategory = try? c.decodeIfPresent(String.self, forKey: .reviewCategory)
    pinned = (try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
    createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    needsYou = (try? c.decodeIfPresent(Bool.self, forKey: .needsYou)) ?? true
    decisionHeadline = try? c.decodeIfPresent(String.self, forKey: .decisionHeadline)
    decisionFact = try? c.decodeIfPresent(String.self, forKey: .decisionFact)
    decisionSource = try? c.decodeIfPresent(FleetDecisionSource.self, forKey: .decisionSource)
    decisionAction = try? c.decodeIfPresent(FleetCardAction.self, forKey: .decisionAction)
    remainingItemIds = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .remainingItemIds)) ?? []).compactMap { $0.value }
    decisionItems = ((try? c.decodeIfPresent([Lossy<FleetDecisionItem>].self, forKey: .decisionItems)) ?? []).compactMap { $0.value }
    askedAt = try? c.decodeIfPresent(String.self, forKey: .askedAt)
    chatLabel = try? c.decodeIfPresent(String.self, forKey: .chatLabel)
    answerIn = try? c.decodeIfPresent(String.self, forKey: .answerIn)
    openChat = try? c.decodeIfPresent(FleetOpenChat.self, forKey: .openChat)
    chats = ((try? c.decodeIfPresent([Lossy<FleetOpenChat>].self, forKey: .chats)) ?? []).compactMap { $0.value }
    risky = (try? c.decodeIfPresent(Bool.self, forKey: .risky)) ?? false
    askContext = try? c.decodeIfPresent(String.self, forKey: .askContext)
    canReply = (try? c.decodeIfPresent(Bool.self, forKey: .canReply)) ?? false
    project = try? c.decodeIfPresent(String.self, forKey: .project)
    if let mc = try? c.nestedContainer(keyedBy: MetaKeys.self, forKey: .meta) {
      plan = try? mc.decodeIfPresent(FleetSuggestionPlan.self, forKey: .plan)
      if let cc = try? mc.nestedContainer(keyedBy: ClarificationKeys.self, forKey: .clarification) {
        clarificationAnswer = try? cc.decodeIfPresent(String.self, forKey: .answer)
      } else {
        clarificationAnswer = nil
      }
    } else {
      plan = nil
      clarificationAnswer = nil
    }
    blockingCount = (try? c.decodeIfPresent(Int.self, forKey: .blockingCount)) ?? 0
    blockingSummary = try? c.decodeIfPresent(String.self, forKey: .blockingSummary)
    actorLabel = try? c.decodeIfPresent(String.self, forKey: .actorLabel)
    subchannel = try? c.decodeIfPresent(String.self, forKey: .subchannel)
    labels = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .labels)) ?? []).compactMap { $0.value }
  }
}

/// What opens one thread's own chat (src/fleet/contracts.js openChatFor).
/// url nil: no link opens it; label names the workspace or folder and the
/// app, and note says why.
struct FleetOpenChat: Decodable, Equatable {
  let app: String?
  let url: String?
  let label: String
  let note: String?
  /// Set on a grouped question's chats.
  let threadKey: String?

  enum CodingKeys: String, CodingKey { case app, url, label, note, threadKey }

  init(app: String?, url: String?, label: String, note: String? = nil, threadKey: String? = nil) {
    self.app = app
    self.url = url
    self.label = label
    self.note = note
    self.threadKey = threadKey
  }

  /// `label` is required: a chat this build cannot name is not offered.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = try c.decode(String.self, forKey: .label).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else {
      throw DecodingError.dataCorruptedError(forKey: .label, in: c, debugDescription: "empty label")
    }
    label = raw
    app = try? c.decodeIfPresent(String.self, forKey: .app)
    url = try? c.decodeIfPresent(String.self, forKey: .url)
    note = try? c.decodeIfPresent(String.self, forKey: .note)
    threadKey = try? c.decodeIfPresent(String.self, forKey: .threadKey)
  }

  /// The link that lands in this exact chat. Only the two app schemes the
  /// daemon sends: a daemon string is never opened as anything else.
  var link: URL? {
    guard let url, let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(),
          Self.schemes.contains(scheme) else { return nil }
    return parsed
  }

  static let schemes: Set<String> = ["conductor", "codex"]

  /// The app that shows this chat.
  var appName: String? {
    switch app {
    case "conductor": return "Conductor"
    case "codex": return "Codex"
    case "claude": return "Claude Code"
    case "antigravity": return "Antigravity"
    default: return nil
    }
  }

  /// With no link, the app that shows the chat's workspace, brought to the
  /// front. A Claude Code terminal session has none.
  var bundleIdentifier: String? {
    switch app {
    case "conductor": return "com.conductor.app"
    case "codex": return "com.openai.codex"
    default: return nil
    }
  }
}

struct FleetActivityEvent: Decodable, Equatable, Identifiable {
  let id: String
  let kind: String
  let actor: String?
  let project: String?
  let subchannel: String?
  let title: String
  let detail: String?
  let threadKey: String?
  let taskId: String?
  let prRef: String?
  let labels: [String]
  let at: String?

  enum CodingKeys: String, CodingKey {
    case id, kind, actor, project, subchannel, title, detail, threadKey, taskId, prRef, labels, at
  }

  init(id: String, kind: String = "action", actor: String? = nil, project: String? = nil,
       subchannel: String? = nil, title: String, detail: String? = nil, threadKey: String? = nil,
       taskId: String? = nil, prRef: String? = nil, labels: [String] = [], at: String? = nil) {
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

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "action"
    actor = try? c.decodeIfPresent(String.self, forKey: .actor)
    project = try? c.decodeIfPresent(String.self, forKey: .project)
    subchannel = try? c.decodeIfPresent(String.self, forKey: .subchannel)
    title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "Activity"
    detail = try? c.decodeIfPresent(String.self, forKey: .detail)
    threadKey = try? c.decodeIfPresent(String.self, forKey: .threadKey)
    taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
    prRef = try? c.decodeIfPresent(String.self, forKey: .prRef)
    labels = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .labels)) ?? []).compactMap { $0.value }
    at = try? c.decodeIfPresent(String.self, forKey: .at)
  }
}

/// The supervisor's health, without its questions. Equatable so the overlay
/// can watch it for height changes (the "Last scan failed" row).
struct FleetStatus: Equatable {
  let mode: String
  let enabled: Bool
  let running: Bool
  let lastTickAt: String?
  let lastError: String?
  let nextTickAt: String?

  init(mode: String, enabled: Bool, running: Bool, lastTickAt: String?, lastError: String?, nextTickAt: String? = nil) {
    self.mode = mode
    self.enabled = enabled
    self.running = running
    self.lastTickAt = lastTickAt
    self.lastError = lastError
    self.nextTickAt = nextTickAt
  }
}

/// GET /fleet/api/state, trimmed to what the overlay shows.
struct FleetState: Decodable, Equatable {
  let mode: String
  let enabled: Bool
  let running: Bool
  let lastTickAt: String?
  let nextTickAt: String?
  let lastError: String?
  let questions: [FleetQuestion]
  /// snapshot.threads: the Watching list. Empty before the first scan.
  let threads: [FleetThread]
  let activityEvents: [FleetActivityEvent]

  enum CodingKeys: String, CodingKey {
    case mode, enabled, running, lastTickAt, nextTickAt, lastError, questions, snapshot, activityEvents
  }
  private enum SnapshotKeys: String, CodingKey { case threads }

  var status: FleetStatus {
    FleetStatus(mode: mode, enabled: enabled, running: running, lastTickAt: lastTickAt, lastError: lastError, nextTickAt: nextTickAt)
  }
}

extension FleetState {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // Empty until the fleet computer has reported one: never a guess.
    mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? ""
    enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
    running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
    lastTickAt = try? c.decodeIfPresent(String.self, forKey: .lastTickAt)
    nextTickAt = try? c.decodeIfPresent(String.self, forKey: .nextTickAt)
    lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
    let raw = (try? c.decodeIfPresent([Lossy<FleetQuestion>].self, forKey: .questions)) ?? []
    questions = raw.compactMap { $0.value }
    // One unreadable row costs that row; a bad snapshot costs the list.
    let snapshot = try? c.nestedContainer(keyedBy: SnapshotKeys.self, forKey: .snapshot)
    let rawThreads = (try? snapshot?.decodeIfPresent([Lossy<FleetThread>].self, forKey: .threads)) ?? nil
    threads = (rawThreads ?? []).compactMap { $0.value }
    activityEvents = ((try? c.decodeIfPresent([Lossy<FleetActivityEvent>].self, forKey: .activityEvents)) ?? []).compactMap { $0.value }
  }
}

struct FleetDelivery: Decodable, Equatable {
  let status: String?
  let detail: String?

  enum CodingKeys: String, CodingKey { case status, detail }

  init(status: String?, detail: String?) {
    self.status = status
    self.detail = detail
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    status = try? c.decodeIfPresent(String.self, forKey: .status)
    detail = try? c.decodeIfPresent(String.self, forKey: .detail)
  }
}

/// POST /fleet/api/questions/:id -> { question, delivery, state }.
struct FleetQuestionResponse: Decodable {
  struct Question: Decodable, Equatable {
    let id: String?
    let status: String?

    enum CodingKeys: String, CodingKey { case id, status }

    init(id: String?, status: String?) {
      self.id = id
      self.status = status
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try? c.decodeIfPresent(String.self, forKey: .id)
      status = try? c.decodeIfPresent(String.self, forKey: .status)
    }
  }

  let question: Question?
  let delivery: FleetDelivery?
  let state: FleetState?

  enum CodingKeys: String, CodingKey { case question, delivery, state }

  init(question: Question?, delivery: FleetDelivery?, state: FleetState?) {
    self.question = question
    self.delivery = delivery
    self.state = state
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    question = try? c.decodeIfPresent(Question.self, forKey: .question)
    delivery = try? c.decodeIfPresent(FleetDelivery.self, forKey: .delivery)
    state = try? c.decodeIfPresent(FleetState.self, forKey: .state)
  }
}

/// Every non-200 fleet route answers { error }, and a failed scan adds { state }.
struct FleetErrorBody: Decodable {
  let error: String?
  let state: FleetState?

  enum CodingKeys: String, CodingKey { case error, state }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    error = try? c.decodeIfPresent(String.self, forKey: .error)
    state = try? c.decodeIfPresent(FleetState.self, forKey: .state)
  }
}

extension BriefChatContext {
  /// Chat about one supervisor question. The daemon resolves the id against
  /// the live supervisor; title/why here are never sent to the model.
  init(question: FleetQuestion) {
    kind = "fleet"
    title = question.title
    why = question.body
    entityRef = BriefEntityRef(kind: "fleet", id: question.id)
  }

  private init(fleetTitle: String) {
    kind = "fleet"
    title = fleetTitle
    why = ""
    entityRef = nil
  }

  /// Chat about the supervisor as a whole: the daemon sends an overview.
  static let fleetOverview = BriefChatContext(fleetTitle: "Supervisor")
}
