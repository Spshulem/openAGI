import Foundation

// One thread, expanded: GET /fleet/api/threads/:key, and the owner's Push
// now, Mute and Unmute of it (src/fleet/routes.js). Same version-skew rules
// as FleetModels: a field this build can't read costs that field.

/// Decodes `T`, or nothing at all.
private struct LossyValue<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// A PR's checks: "success", "failure", "pending", with the check names.
struct FleetCI: Decodable, Equatable {
  let state: String?
  let failing: [String]
  let pending: [String]

  enum CodingKeys: String, CodingKey { case state, failing, pending }

  init(state: String?, failing: [String] = [], pending: [String] = []) {
    self.state = state
    self.failing = failing
    self.pending = pending
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    state = try? c.decodeIfPresent(String.self, forKey: .state)
    failing = ((try? c.decodeIfPresent([LossyValue<String>].self, forKey: .failing)) ?? []).compactMap { $0.value }
    pending = ((try? c.decodeIfPresent([LossyValue<String>].self, forKey: .pending)) ?? []).compactMap { $0.value }
  }
}

/// A thread's PR as the last scan read it. A PR named in the chat but never
/// read has only `ref`.
struct FleetPR: Decodable, Equatable {
  let ref: String?
  let url: String?
  let state: String?
  let title: String?
  let ci: FleetCI?
  let unresolvedThreads: Int?
  let mergeState: String?

  enum CodingKeys: String, CodingKey { case ref, url, state, title, ci, unresolvedThreads, mergeState }

  init(ref: String?, url: String? = nil, state: String? = nil, title: String? = nil, ci: FleetCI? = nil,
       unresolvedThreads: Int? = nil, mergeState: String? = nil) {
    self.ref = ref
    self.url = url
    self.state = state
    self.title = title
    self.ci = ci
    self.unresolvedThreads = unresolvedThreads
    self.mergeState = mergeState
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ref = try? c.decodeIfPresent(String.self, forKey: .ref)
    url = try? c.decodeIfPresent(String.self, forKey: .url)
    state = try? c.decodeIfPresent(String.self, forKey: .state)
    title = try? c.decodeIfPresent(String.self, forKey: .title)
    ci = try? c.decodeIfPresent(FleetCI.self, forKey: .ci)
    unresolvedThreads = try? c.decodeIfPresent(Int.self, forKey: .unresolvedThreads)
    mergeState = try? c.decodeIfPresent(String.self, forKey: .mergeState)
  }
}

/// The supervisor's next step for a thread, and why. `message`: the words a
/// nudge would send, which is what Push now sends.
struct FleetDecision: Decodable, Equatable {
  let action: String?
  let playbook: String?
  let reason: String?
  let notBefore: String?
  let message: String?

  enum CodingKeys: String, CodingKey { case action, playbook, reason, notBefore, message }

  init(action: String?, playbook: String? = nil, reason: String? = nil, notBefore: String? = nil, message: String? = nil) {
    self.action = action
    self.playbook = playbook
    self.reason = reason
    self.notBefore = notBefore
    self.message = message
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    action = try? c.decodeIfPresent(String.self, forKey: .action)
    playbook = try? c.decodeIfPresent(String.self, forKey: .playbook)
    reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    notBefore = try? c.decodeIfPresent(String.self, forKey: .notBefore)
    message = try? c.decodeIfPresent(String.self, forKey: .message)
  }
}

/// GET /fleet/api/threads/:key -> { thread }, trimmed to what the expanded
/// row shows. Only `key` is required.
struct FleetThreadDetail: Decodable, Equatable {
  let key: String
  let title: String?
  let workspace: String?
  let branch: String?
  let agentStatus: String?
  let reason: String?
  let blockers: [String]
  /// The agent's last message: its last 1200 characters, secrets redacted.
  let lastAgentText: String?
  let lastAgentAt: String?
  let lastOwnerAt: String?
  let pr: FleetPR?
  let watch: FleetWatch?
  let decision: FleetDecision?
  let pushPreview: FleetDecision?
  let muted: String?
  let openChat: FleetOpenChat?
  let scannedAt: String?

  enum CodingKeys: String, CodingKey {
    case key, title, workspace, branch, agentStatus, reason, blockers, lastAgentMessage, lastOwnerAt, pr, watch, decision, pushPreview, muted, openChat, scannedAt
  }
  private enum MessageKeys: String, CodingKey { case text, at }
  private enum Envelope: String, CodingKey { case thread }

  init(key: String, title: String? = nil, workspace: String? = nil, branch: String? = nil, agentStatus: String? = nil,
       reason: String? = nil, blockers: [String] = [], lastAgentText: String? = nil, lastAgentAt: String? = nil,
       lastOwnerAt: String? = nil, pr: FleetPR? = nil, watch: FleetWatch? = nil, decision: FleetDecision? = nil,
       muted: String? = nil, openChat: FleetOpenChat? = nil, scannedAt: String? = nil, pushPreview: FleetDecision? = nil) {
    self.key = key
    self.title = title
    self.workspace = workspace
    self.branch = branch
    self.agentStatus = agentStatus
    self.reason = reason
    self.blockers = blockers
    self.lastAgentText = lastAgentText
    self.lastAgentAt = lastAgentAt
    self.lastOwnerAt = lastOwnerAt
    self.pr = pr
    self.watch = watch
    self.decision = decision
    self.pushPreview = pushPreview
    self.muted = muted
    self.openChat = openChat
    self.scannedAt = scannedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    title = try? c.decodeIfPresent(String.self, forKey: .title)
    workspace = try? c.decodeIfPresent(String.self, forKey: .workspace)
    branch = try? c.decodeIfPresent(String.self, forKey: .branch)
    agentStatus = try? c.decodeIfPresent(String.self, forKey: .agentStatus)
    reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    blockers = ((try? c.decodeIfPresent([LossyValue<String>].self, forKey: .blockers)) ?? []).compactMap { $0.value }
    let message = try? c.nestedContainer(keyedBy: MessageKeys.self, forKey: .lastAgentMessage)
    lastAgentText = (try? message?.decodeIfPresent(String.self, forKey: .text)) ?? nil
    lastAgentAt = (try? message?.decodeIfPresent(String.self, forKey: .at)) ?? nil
    lastOwnerAt = try? c.decodeIfPresent(String.self, forKey: .lastOwnerAt)
    pr = try? c.decodeIfPresent(FleetPR.self, forKey: .pr)
    watch = try? c.decodeIfPresent(FleetWatch.self, forKey: .watch)
    decision = try? c.decodeIfPresent(FleetDecision.self, forKey: .decision)
    pushPreview = try? c.decodeIfPresent(FleetDecision.self, forKey: .pushPreview)
    muted = try? c.decodeIfPresent(String.self, forKey: .muted)
    openChat = try? c.decodeIfPresent(FleetOpenChat.self, forKey: .openChat)
    scannedAt = try? c.decodeIfPresent(String.self, forKey: .scannedAt)
  }

  /// The route's `{ thread }` body.
  static func decodeResponse(_ data: Data) -> FleetThreadDetail? {
    struct Body: Decodable { let thread: FleetThreadDetail }
    return (try? JSONDecoder().decode(Body.self, from: data))?.thread
  }
}

/// POST /fleet/api/threads/:key/push -> { delivery, action, state }, and
/// /mute, /unmute -> { muted, state }.
struct FleetThreadActionResponse: Decodable {
  let delivery: FleetDelivery?
  let muted: String?
  let state: FleetState?

  enum CodingKeys: String, CodingKey { case delivery, muted, state }

  init(delivery: FleetDelivery?, muted: String? = nil, state: FleetState? = nil) {
    self.delivery = delivery
    self.muted = muted
    self.state = state
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    delivery = try? c.decodeIfPresent(FleetDelivery.self, forKey: .delivery)
    muted = try? c.decodeIfPresent(String.self, forKey: .muted)
    state = try? c.decodeIfPresent(FleetState.self, forKey: .state)
  }
}

/// The expanded row's lines. The state's row is the live one (its watch is
/// regrouped on every read); the detail adds the agent's longer, redacted
/// last message and the owner's last word, and stands in for a thread the
/// row list doesn't have. Pure, unit-tested.
struct FleetThreadSummary: Equatable {
  /// The agent's last message, an excerpt.
  let excerpt: String?
  /// "2h ago".
  let excerptAge: String?
  /// "repo#12 · open · CI failing: lint, test · 2 unresolved".
  let prLine: String?
  let prLink: URL?
  /// "Waits on CI for 23m", "Waits on your answer for 8h".
  let waitLine: String?
  /// "Next: nudge. CI failing on #12", "Next: wait until 14:05. cooldown".
  let nextLine: String?
  /// The words Push now would send.
  let pushMessage: String?
  /// "Muted until 3:00 PM".
  let mutedLine: String?
  let muted: Bool
  /// "You last wrote 3h ago".
  let ownerLine: String?

  static let excerptMax = 600

  init(thread: FleetThread?, detail: FleetThreadDetail?, now: Date = Date()) {
    // The detail carries the longer excerpt.
    let rowAt = thread?.lastAgentAt.flatMap(FleetWatching.parseDate)
    let detailAt = detail?.lastAgentAt.flatMap(FleetWatching.parseDate)
    let newerRow = rowAt.map { rowTime in detailAt.map { rowTime > $0 } ?? true } ?? false
    let text = (newerRow ? thread?.lastAgentText : detail?.lastAgentText ?? thread?.lastAgentText)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    excerpt = text.isEmpty ? nil : Self.tail(text, Self.excerptMax)
    excerptAge = excerpt == nil ? nil : (newerRow ? thread?.lastAgentAt : detail?.lastAgentAt ?? thread?.lastAgentAt).flatMap(FleetWatching.parseDate).map { Self.ago($0, now: now) }

    let row = thread ?? detail.map { FleetThread(key: $0.key, prRef: $0.pr?.ref, prURL: $0.pr?.url, watch: $0.watch) }
    let pr = thread?.pr ?? detail?.pr
    prLine = pr.flatMap { Self.prLine($0, shortRef: row?.prShortRef) }
    prLink = row?.prLink

    let watch = thread?.watch ?? detail?.watch
    waitLine = watch.flatMap { Self.waitLine($0, now: now) }

    let decision = thread?.decision ?? detail?.decision
    nextLine = decision.flatMap { Self.nextLine($0, now: now) }
    let preview = thread != nil ? thread?.pushPreview : detail?.pushPreview
    let message = preview?.action == "nudge" ? (preview?.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") : ""
    pushMessage = message.isEmpty ? nil : message

    let mutedAt = (thread?.muted ?? detail?.muted).flatMap(FleetWatching.parseDate)
    muted = mutedAt.map { $0 > now } ?? false
    mutedLine = muted ? mutedAt.map { "Muted until \(Self.clock($0, now: now))" } : nil

    let ownerAt = thread?.lastOwnerAt ?? detail?.lastOwnerAt
    ownerLine = ownerAt.flatMap(FleetWatching.parseDate).map { "You last wrote \(Self.ago($0, now: now))" }
  }

  static func prLine(_ pr: FleetPR, shortRef: String?) -> String? {
    var parts: [String] = []
    if let ref = shortRef ?? pr.ref, !ref.isEmpty { parts.append(ref) }
    if let state = pr.state?.lowercased(), !state.isEmpty { parts.append(state) }
    if let ci = pr.ci, let state = ci.state?.lowercased(), !state.isEmpty {
      switch state {
      case "failure", "failing", "error":
        parts.append(ci.failing.isEmpty ? "CI failing" : "CI failing: \(ci.failing.prefix(3).joined(separator: ", "))")
      case "pending":
        parts.append(ci.pending.isEmpty ? "CI running" : "CI running: \(ci.pending.prefix(3).joined(separator: ", "))")
      case "success": parts.append("CI green")
      default: parts.append("CI \(state)")
      }
    }
    if let open = pr.unresolvedThreads, open > 0 { parts.append("\(open) unresolved") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// What the thread waits on and since when, in the owner's words.
  static func waitLine(_ watch: FleetWatch, now: Date) -> String? {
    let on = watch.waitingOn?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let since = (watch.group == "waiting" ? watch.waitSince ?? watch.since : watch.since).flatMap(FleetWatching.parseDate)
    let time = since.map { " for \(FleetWatching.duration(now.timeIntervalSince($0)))" } ?? ""
    switch watch.group {
    case "you": return "Waits on \(on.isEmpty ? "your answer" : on)\(time)"
    case "waiting": return "Waits on \(on.isEmpty ? "CI or BuildBot3" : on)\(time)"
    case "working": return "Agent working\(time)"
    case "push": return "Stopped\(time); the supervisor pushes it"
    case "blocked": return "Blocked by infra\(time)"
    default: return on.isEmpty ? (time.isEmpty ? nil : "Quiet\(time)") : "Waits on \(on)\(time)"
    }
  }

  /// "Next: nudge. <why>"; a wait names when it ends.
  static func nextLine(_ decision: FleetDecision, now: Date) -> String? {
    let action = decision.action?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !action.isEmpty else { return nil }
    let words: String
    switch action {
    case "nudge": words = "nudge the agent"
    case "ask-user": words = "ask you"
    case "wait": words = decision.notBefore.flatMap(FleetWatching.parseDate).map { "wait until \(clock($0, now: now))" } ?? "wait"
    case "none", "skip": words = "nothing"
    default: words = action.replacingOccurrences(of: "-", with: " ")
    }
    let reason = decision.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return reason.isEmpty ? "Next: \(words)." : "Next: \(words). \(reason)"
  }

  static func ago(_ date: Date, now: Date) -> String {
    let s = now.timeIntervalSince(date)
    return s < 60 ? "just now" : "\(FleetWatching.duration(s)) ago"
  }

  /// "3:05 PM" today, "Oct 14, 3:05 PM" otherwise.
  static func clock(_ date: Date, now: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = Calendar.current.isDate(date, inSameDayAs: now) ? "h:mm a" : "MMM d, h:mm a"
    return formatter.string(from: date)
  }

  /// The end of a long message, where the agent's latest words are.
  static func tail(_ text: String, _ max: Int) -> String {
    guard text.count > max else { return text }
    return "\u{2026}" + String(text.suffix(max - 1))
  }
}

/// What Push now, Mute or Unmute did, in the owner's words.
enum FleetThreadOutcome {
  static func push(_ delivery: FleetDelivery?) -> FleetNote {
    let detail = delivery?.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let shown = detail.isEmpty ? nil : String(detail.prefix(300))
    switch delivery?.status {
    case "sent": return FleetNote(text: "Pushed. Sent to the agent.", isError: false)
    case "queued": return FleetNote(text: shown ?? "Saved. It goes once the Mac can type.", isError: false)
    case "dry-run": return FleetNote(text: "Dry run, nothing sent.", isError: false)
    case "blocked": return FleetNote(text: "Not sent: \(shown ?? "blocked")", isError: true)
    default: return FleetNote(text: "Not sent: \(shown ?? "the send failed")", isError: true)
    }
  }

  static func muted(_ until: String?, now: Date = Date()) -> FleetNote {
    guard let at = until.flatMap(FleetWatching.parseDate) else { return FleetNote(text: "Unmuted.", isError: false) }
    return FleetNote(text: "Muted until \(FleetThreadSummary.clock(at, now: now)).", isError: false)
  }
}

/// "Open chat": a link that lands in that exact chat, else the app that
/// shows its workspace, else nothing (a Claude Code terminal session), with
/// the label and note saying where it is.
enum FleetChatOpener {
  enum Target: Equatable {
    case link(URL)
    case app(bundleIdentifier: String, name: String)
    /// No link and no app to bring forward: the label says where it is.
    case nowhere
  }

  static func target(_ chat: FleetOpenChat) -> Target {
    if let link = chat.link { return .link(link) }
    if let bundle = chat.bundleIdentifier, let name = chat.appName { return .app(bundleIdentifier: bundle, name: name) }
    return .nowhere
  }

  /// The button's words: "Open chat" for a link, "Open Conductor" for the app.
  static func buttonTitle(_ chat: FleetOpenChat) -> String? {
    switch target(chat) {
    case .link: return "Open chat"
    case let .app(_, name): return "Open \(name)"
    case .nowhere: return nil
    }
  }
}
