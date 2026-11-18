import Foundation

// "Watching": what the supervisor watches each coding thread for, and for how
// long (snapshot.threads[].watch, src/fleet/classify.js watchOf). Same groups,
// labels, order and wording as the /fleet page (src/fleet/page.js renderFleet).

/// One thread's watch: its group, what it waits on, and since when.
struct FleetWatch: Decodable, Equatable {
  /// you | working | waiting | push | blocked | quiet (a newer daemon may add more).
  let group: String
  /// When the thread entered this group (held across scans).
  let since: String?
  /// "BuildBot3 full run", "bb-quick", "CI", "your answer"…
  let waitingOn: String?
  let waitSince: String?
  let runningSince: String?
  /// On a "you" row: its group once the owner's question closes.
  let otherwiseGroup: String?

  enum CodingKeys: String, CodingKey { case group, since, waitingOn, waitSince, runningSince, otherwise }
  private enum OtherwiseKeys: String, CodingKey { case group }

  init(group: String, since: String?, waitingOn: String? = nil, waitSince: String? = nil, runningSince: String? = nil,
       otherwiseGroup: String? = nil) {
    self.group = group
    self.since = since
    self.waitingOn = waitingOn
    self.waitSince = waitSince
    self.runningSince = runningSince
    self.otherwiseGroup = otherwiseGroup
  }

  /// `group` is required: a watch without one says nothing.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = try c.decode(String.self, forKey: .group).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else {
      throw DecodingError.dataCorruptedError(forKey: .group, in: c, debugDescription: "empty group")
    }
    group = raw
    since = try? c.decodeIfPresent(String.self, forKey: .since)
    waitingOn = try? c.decodeIfPresent(String.self, forKey: .waitingOn)
    waitSince = try? c.decodeIfPresent(String.self, forKey: .waitSince)
    runningSince = try? c.decodeIfPresent(String.self, forKey: .runningSince)
    let otherwise = try? c.nestedContainer(keyedBy: OtherwiseKeys.self, forKey: .otherwise)
    otherwiseGroup = (try? otherwise?.decodeIfPresent(String.self, forKey: .group)) ?? nil
  }

  /// A daemon from before watch existed: the group its state maps to (the
  /// daemon's own WATCH_BY_STATE), timed from the thread's last activity.
  /// Out of scope (or no state at all): not watched.
  static func fallback(state: String?, lastActivityAt: String?) -> FleetWatch? {
    guard let state, !state.isEmpty, state != "excluded" else { return nil }
    return FleetWatch(group: groupByState[state] ?? "quiet", since: lastActivityAt)
  }

  private static let groupByState: [String: String] = [
    "running": "working",
    "waiting-ci": "waiting",
    "needs-human": "you", "ready-needs-human": "you",
    "asked-in-scope": "push", "pr-not-ready": "push", "stopped": "push", "local-verify": "push",
    "infra-blocked": "blocked",
    "idle-no-pr": "quiet", "done": "quiet"
  ]
}

/// One row of snapshot.threads, trimmed to what the Watching list shows.
struct FleetThread: Decodable, Equatable, Identifiable {
  let key: String
  let title: String?
  let workspace: String?
  let repo: String?
  let host: String?
  let cwd: String?
  let state: String?
  let prRef: String?
  let prURL: String?
  let lastActivityAt: String?
  let lastAgentAt: String?
  /// Nil: out of scope (the daemon sent watch: null), so not listed.
  let watch: FleetWatch?
  /// The scan's PR read: state, title, CI, unresolved review threads.
  let pr: FleetPR?
  /// The redacted tail of the agent's last message.
  let lastAgentText: String?
  let lastOwnerAt: String?
  /// When the owner's Mute ends; nil: not muted.
  let muted: String?
  /// What opens this exact chat.
  let openChat: FleetOpenChat?
  /// The supervisor's next step, and the words Push now would send.
  let decision: FleetDecision?
  let pushPreview: FleetDecision?
  let pushing: Bool

  var id: String { key }

  enum CodingKeys: String, CodingKey {
    case key, title, workspace, repo, host, cwd, state, pr, lastActivityAt, lastAgentAt, watch
    case lastAgentText, lastOwnerAt, muted, openChat, decision, pushPreview, pushing
  }
  private enum PRKeys: String, CodingKey { case ref, url }

  init(key: String, title: String? = nil, workspace: String? = nil, repo: String? = nil, host: String? = nil, cwd: String? = nil, state: String? = nil,
       prRef: String? = nil, prURL: String? = nil, lastActivityAt: String? = nil, lastAgentAt: String? = nil,
       watch: FleetWatch?, pr: FleetPR? = nil, lastAgentText: String? = nil, lastOwnerAt: String? = nil,
       muted: String? = nil, openChat: FleetOpenChat? = nil, decision: FleetDecision? = nil, pushPreview: FleetDecision? = nil, pushing: Bool = false) {
    self.key = key
    self.title = title
    self.workspace = workspace
    self.repo = repo
    self.host = host
    self.cwd = cwd
    self.state = state
    self.prRef = prRef
    self.prURL = prURL
    self.lastActivityAt = lastActivityAt
    self.lastAgentAt = lastAgentAt
    self.watch = watch
    self.pr = pr
    self.lastAgentText = lastAgentText
    self.lastOwnerAt = lastOwnerAt
    self.muted = muted
    self.openChat = openChat
    self.decision = decision
    self.pushPreview = pushPreview
    self.pushing = pushing
  }

  /// Only `key` is required. A daemon that sends no watch key at all predates
  /// Watching: the row is grouped by its state instead. watch: null is a
  /// newer daemon saying "out of scope"; an unreadable watch falls back too.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    title = try? c.decodeIfPresent(String.self, forKey: .title)
    workspace = try? c.decodeIfPresent(String.self, forKey: .workspace)
    repo = try? c.decodeIfPresent(String.self, forKey: .repo)
    host = try? c.decodeIfPresent(String.self, forKey: .host)
    cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
    state = try? c.decodeIfPresent(String.self, forKey: .state)
    let prKeys = try? c.nestedContainer(keyedBy: PRKeys.self, forKey: .pr)
    prRef = (try? prKeys?.decodeIfPresent(String.self, forKey: .ref)) ?? nil
    prURL = (try? prKeys?.decodeIfPresent(String.self, forKey: .url)) ?? nil
    lastActivityAt = try? c.decodeIfPresent(String.self, forKey: .lastActivityAt)
    lastAgentAt = try? c.decodeIfPresent(String.self, forKey: .lastAgentAt)
    pr = try? c.decodeIfPresent(FleetPR.self, forKey: .pr)
    lastAgentText = try? c.decodeIfPresent(String.self, forKey: .lastAgentText)
    lastOwnerAt = try? c.decodeIfPresent(String.self, forKey: .lastOwnerAt)
    muted = try? c.decodeIfPresent(String.self, forKey: .muted)
    openChat = try? c.decodeIfPresent(FleetOpenChat.self, forKey: .openChat)
    decision = try? c.decodeIfPresent(FleetDecision.self, forKey: .decision)
    pushPreview = try? c.decodeIfPresent(FleetDecision.self, forKey: .pushPreview)
    pushing = (try? c.decodeIfPresent(Bool.self, forKey: .pushing)) ?? false
    if c.contains(.watch), (try? c.decodeNil(forKey: .watch)) == true {
      watch = nil
    } else if let decoded = try? c.decodeIfPresent(FleetWatch.self, forKey: .watch) {
      watch = decoded
    } else {
      watch = FleetWatch.fallback(state: state, lastActivityAt: lastActivityAt)
    }
  }

  /// The row's name: the chat title, else its workspace, else its key.
  var name: String {
    for candidate in [title, workspace] {
      if let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
    }
    return key
  }

  /// "owner/repo#123" -> "repo#123", as on the /fleet page.
  var prShortRef: String? {
    guard let ref = prRef?.trimmingCharacters(in: .whitespacesAndNewlines), !ref.isEmpty else { return nil }
    guard let hash = ref.lastIndex(of: "#"), let slash = ref[..<hash].lastIndex(of: "/") else { return ref }
    return String(ref[ref.index(after: slash)...])
  }

  /// Only GitHub pull request URLs open; anything else stays text.
  var prLink: URL? {
    if let url = prURL, url.range(of: #"^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$"#, options: .regularExpression) != nil {
      return URL(string: url)
    }
    guard let ref = prRef, let match = ref.range(of: #"^[\w.-]+/[\w.-]+#\d+$"#, options: .regularExpression) else { return nil }
    let parts = ref[match].split(separator: "#")
    return URL(string: "https://github.com/\(parts[0])/pull/\(parts[1])")
  }
}

/// The Watching list's pure layout: groups, order, row text. Unit-tested.
enum FleetWatching {
  static let order = ["you", "working", "waiting", "push", "blocked", "quiet"]
  static let labels: [String: String] = [
    "you": "Waiting on you",
    "working": "Working",
    "waiting": "Waiting on CI or BuildBot3",
    "push": "Needs a push",
    "blocked": "Blocked by infra",
    "quiet": "Quiet"
  ]
  /// Collapsed until the owner opens it.
  static let collapsedByDefault: Set<String> = ["quiet"]
  /// Rows shown in each open group, so one busy group (16 questions waiting
  /// on the owner) cannot push the CI and BuildBot3 waits out of sight.
  static let perGroupLimit = 4
  /// Rows shown in all before "N more".
  static let rowLimit = 20

  static func label(_ group: String) -> String { labels[group] ?? group }

  struct Group: Equatable, Identifiable {
    let group: String
    let label: String
    let threads: [FleetThread]
    var id: String { group }
  }

  /// Watched threads by group, in the page's order (unknown groups after,
  /// first seen first). Longest wait first inside a group; Quiet newest
  /// activity first. Out-of-scope threads are left out.
  static func groups(_ threads: [FleetThread]) -> [Group] {
    var byGroup: [String: [FleetThread]] = [:]
    var extra: [String] = []
    for thread in threads {
      guard let group = thread.watch?.group else { continue }
      if byGroup[group] == nil, !order.contains(group) { extra.append(group) }
      byGroup[group, default: []].append(thread)
    }
    return (order + extra).compactMap { group in
      guard let list = byGroup[group] else { return nil }
      return Group(group: group, label: label(group), threads: sorted(list, group: group))
    }
  }

  private static func sorted(_ list: [FleetThread], group: String) -> [FleetThread] {
    if group == "quiet" {
      return list.sorted { a, b in
        ordered(a.lastActivityAt, b.lastActivityAt, newestFirst: true, tie: a.key < b.key)
      }
    }
    return list.sorted { a, b in
      ordered(a.watch?.since, b.watch?.since, newestFirst: false, tie: a.key < b.key)
    }
  }

  /// a before b by time, oldest or newest first. Unreadable times go last.
  private static func ordered(_ a: String?, _ b: String?, newestFirst: Bool, tie: Bool) -> Bool {
    let da = a.flatMap(parseDate), db = b.flatMap(parseDate)
    switch (da, db) {
    case let (x?, y?): return x == y ? tie : (newestFirst ? x > y : x < y)
    case (.some, nil): return true
    case (nil, .some): return false
    case (nil, nil): return tie
    }
  }

  struct Section: Equatable, Identifiable {
    let group: String
    let label: String
    let total: Int
    let collapsed: Bool
    let rows: [FleetThread]
    var id: String { group }
  }

  struct Layout: Equatable {
    let sections: [Section]
    /// Rows past the limit in open groups: the "N more" link.
    let hidden: Int
  }

  /// At most `perGroup` rows in each open group and `limit` in all, in group
  /// order. A collapsed group shows only its header and uses up nothing.
  static func layout(_ threads: [FleetThread], openGroups: Set<String>, limit: Int = rowLimit, perGroup: Int = perGroupLimit) -> Layout {
    var budget = max(0, limit)
    var hidden = 0
    let sections = groups(threads).map { g -> Section in
      let collapsed = collapsedByDefault.contains(g.group) && !openGroups.contains(g.group)
      if collapsed { return Section(group: g.group, label: g.label, total: g.threads.count, collapsed: true, rows: []) }
      let shown = Array(g.threads.prefix(min(budget, max(0, perGroup))))
      budget -= shown.count
      hidden += g.threads.count - shown.count
      return Section(group: g.group, label: g.label, total: g.threads.count, collapsed: false, rows: shown)
    }
    return Layout(sections: sections, hidden: hidden)
  }

  /// "on BuildBot3 full run for 23m" while waiting, "for 12m" otherwise.
  static func rowText(_ watch: FleetWatch, now: Date = Date()) -> String? {
    let waitingOn = watch.waitingOn?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let on = watch.group == "waiting" && !waitingOn.isEmpty ? "on \(waitingOn)" : nil
    guard let since = watch.since.flatMap(parseDate) else { return on }
    let text = "for \(duration(now.timeIntervalSince(since)))"
    return on.map { "\($0) \(text)" } ?? text
  }

  /// The row's visible label, short so the chat name keeps its room:
  /// "task 6h", "CI 12m", "BB3 full 23m" while waiting, "2h" otherwise.
  /// rowText stays the full sentence for the tooltip and VoiceOver.
  static func shortRowText(_ watch: FleetWatch, now: Date = Date()) -> String? {
    let waitingOn = watch.waitingOn?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let on = watch.group == "waiting" && !waitingOn.isEmpty ? shortWaitingOn(waitingOn) : nil
    guard let since = watch.since.flatMap(parseDate) else { return on }
    let text = duration(now.timeIntervalSince(since))
    return on.map { "\($0) \(text)" } ?? text
  }

  static func shortWaitingOn(_ value: String) -> String {
    switch value {
    case "a background task": return "task"
    case "BuildBot3 full run": return "BB3 full"
    default: return value
    }
  }

  /// "45s", "23m", "2h", "3d": the /fleet page's secs(), rounding included.
  static func duration(_ seconds: TimeInterval) -> String {
    let s = max(0, seconds)
    if s < 60 { return "\(Int(s.rounded()))s" }
    let m = (s / 60).rounded()
    if m < 60 { return "\(Int(m))m" }
    let h = (m / 60).rounded()
    if h < 48 { return "\(Int(h))h" }
    return "\(Int((h / 24).rounded()))d"
  }

  static func parseDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
  }
}
