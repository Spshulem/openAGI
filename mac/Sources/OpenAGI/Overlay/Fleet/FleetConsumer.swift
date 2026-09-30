import Foundation

/// The coding-agent supervisor's open questions, from the LOCAL daemon's
/// /fleet/api/* routes (the same JSON the /fleet page uses).
///
/// Fails soft: a daemon without a supervisor (404/503), or one that is off
/// with nothing open, just hides the Supervisor tab (never while the owner is
/// on it). Nothing here is optimistic — an answer can take minutes to reach
/// the agent (typing into an app), and the question stays on screen, in
/// flight, until the daemon says what happened.
@MainActor
final class FleetConsumer: ObservableObject {
  static let shared = FleetConsumer()

  @Published private(set) var questions: [FleetQuestion] = []
  @Published private(set) var status: FleetStatus? = nil
  /// False hides the Supervisor tab.
  @Published private(set) var available = false
  @Published private(set) var isLoading = false
  @Published private(set) var scanning = false
  /// Question ids with an answer or dismissal in flight.
  @Published private(set) var inFlight: Set<String> = []
  /// Answers that timed out here while the daemon may still be delivering
  /// them. Their buttons stay off until the question closes or the wait ends:
  /// a second tap would only hit the daemon's in-progress guard.
  @Published private(set) var stillSending: Set<String> = []
  /// Each open question's last result, shown in its own row, so two answers
  /// in flight can never be mixed up.
  @Published private(set) var notes: [String: FleetNote] = [:]
  /// Scan, refresh, and closed-question results.
  @Published private(set) var lastOutcome: String? = nil
  @Published private(set) var lastError: String? = nil

  /// Bumped by every refresh start and every apply. A refresh publishes only
  /// if nothing newer started or landed meanwhile, so a slow GET can never
  /// overwrite the state an answer or a scan just returned.
  private var generation: UInt64 = 0
  /// Depth counter, not a Bool: overlapping refreshes each own one decrement.
  private var loadingDepth = 0
  /// True when `lastError` came from a refresh, so the next good refresh may
  /// clear it. An answer's error stays until Dismiss or the next action.
  private var refreshOwnsError = false
  /// What the last state said: a supervisor that is on, or has questions.
  /// `available` can stay true past this while the owner is on the tab.
  private var hasSupervisor = false
  /// When each `stillSending` wait ends.
  private var sendingDeadline: [String: Date] = [:]
  /// One follow-up refresh while a tick runs: a tick that throws never emits
  /// its "fleet" event, and `running` must not stick.
  private var runningRecheck: Task<Void, Never>?
  private static let stillSendingWait: TimeInterval = 300

  func refresh() async {
    generation &+= 1
    let mine = generation
    loadingDepth += 1
    isLoading = true
    defer {
      loadingDepth = max(0, loadingDepth - 1)
      isLoading = loadingDepth > 0
    }
    let req = request(path: "/fleet/api/state", method: "GET", timeout: 6)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      guard mine == generation else { return }
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        guard let state = try? JSONDecoder().decode(FleetState.self, from: data) else {
          refreshFailed()
          return
        }
        apply(state)
        setRefreshError(nil)
      case 404, 503:
        // No supervisor on this daemon (or a daemon too old to have one).
        clearState()
        setRefreshError(nil)
      case 401:
        setRefreshError("Daemon sign-in failed.")
      default:
        refreshFailed()
      }
    } catch {
      guard mine == generation else { return }
      refreshFailed()
    }
  }

  func answer(_ question: FleetQuestion, option: String) async {
    await decide(question, body: ["answer": option], dismissed: false)
  }

  func dismiss(_ question: FleetQuestion) async {
    await decide(question, body: ["dismiss": true], dismissed: true)
  }

  private func decide(_ question: FleetQuestion, body: [String: Any], dismissed: Bool) async {
    let id = question.id
    guard !inFlight.contains(id), !stillSending.contains(id) else { return }
    inFlight.insert(id)
    defer { inFlight.remove(id) }
    notes[id] = nil

    var req = request(path: "/fleet/api/questions/\(id)", method: "POST", timeout: 150)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        let decoded = try? JSONDecoder().decode(FleetQuestionResponse.self, from: data)
        if let state = decoded?.state { apply(state) } else { await refresh() }
        let result = Self.outcome(decoded, dismissed: dismissed)
        report(question, result.text, isError: result.isError)
      case 409:
        // The daemon is still inside an earlier answer to this question
        // (its in-progress guard), or another surface closed it.
        await refresh()
        if isOpen(id) {
          report(question, "The last answer is still being sent. Check back in a minute.", isError: false)
        } else {
          report(question, Self.serverError(data) ?? "Question already closed.", isError: true)
        }
      case 400, 404, 500:
        await refresh()
        report(question, Self.serverError(data) ?? "The supervisor couldn't take that answer.", isError: true)
      case 503:
        report(question, "Supervisor isn't available.", isError: true)
      case 401:
        report(question, "Daemon sign-in failed.", isError: true)
      default:
        report(question, "Couldn't reach the supervisor. Try again.", isError: true)
      }
    } catch let error as URLError where error.code == .timedOut {
      markStillSending(id)
      report(question, "No reply yet. It may still be sending.", isError: false)
      await refresh()
    } catch {
      report(question, "Couldn't reach the supervisor. Try again.", isError: true)
    }
  }

  /// In the question's row while it is open; once it has closed, the
  /// panel-wide line, named, since the row is gone.
  private func report(_ question: FleetQuestion, _ text: String, isError: Bool) {
    if isOpen(question.id) {
      notes[question.id] = FleetNote(text: text, isError: isError)
    } else if isError {
      setActionError("\(Self.named(question)): \(text)")
    } else {
      lastOutcome = "\(Self.named(question)): \(text)"
    }
  }

  private func isOpen(_ id: String) -> Bool { questions.contains { $0.id == id } }

  private func markStillSending(_ id: String) {
    stillSending.insert(id)
    let deadline = Date().addingTimeInterval(Self.stillSendingWait)
    sendingDeadline[id] = deadline
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(FleetConsumer.stillSendingWait * 1_000_000_000))
      guard let self, let current = self.sendingDeadline[id], current <= Date() else { return }
      self.sendingDeadline[id] = nil
      self.stillSending.remove(id)
      await self.refresh()
    }
  }

  func clearNote(_ id: String) {
    notes[id] = nil
  }

  /// "Scan now": a full supervisor tick, which rechecks every open question.
  func scan() async {
    guard !scanning else { return }
    scanning = true
    defer { scanning = false }
    clearOutcome()

    var req = request(path: "/fleet/api/scan", method: "POST", timeout: 330)
    req.httpBody = Data("{}".utf8)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        if let state = try? JSONDecoder().decode(FleetState.self, from: data) {
          apply(state)
        } else {
          await refresh()
        }
      case 500:
        let state = (try? JSONDecoder().decode(FleetErrorBody.self, from: data))?.state
        if let state { apply(state) }
        // The status line already says "Last scan failed: …"; one red row is enough.
        if (state?.lastError ?? "").isEmpty { setActionError("Scan failed.") }
      case 404, 503:
        setActionError("Supervisor isn't available.")
      case 401:
        setActionError("Daemon sign-in failed.")
      default:
        setActionError(Self.serverError(data) ?? "Scan failed.")
      }
    } catch let error as URLError where error.code == .timedOut {
      setActionError("The scan is still running. Check back soon.")
      await refresh()
    } catch {
      setActionError("Couldn't reach the supervisor. Try again.")
    }
  }

  func clearOutcome() {
    lastOutcome = nil
    lastError = nil
    refreshOwnsError = false
  }

  // MARK: - State

  private func apply(_ state: FleetState) {
    generation &+= 1
    let open = Set(state.questions.map(\.id))
    // A timed-out answer whose question has since closed: say so, since its
    // row (and the "may still be sending" note in it) is about to go.
    for id in stillSending where !open.contains(id) {
      if let old = questions.first(where: { $0.id == id }) { lastOutcome = "\(Self.named(old)): closed." }
      sendingDeadline[id] = nil
    }
    stillSending.formIntersection(open)
    notes = notes.filter { open.contains($0.key) }
    questions = state.questions
    status = state.status
    hasSupervisor = state.enabled || !state.questions.isEmpty
    // Answering the last question with auto-scan off must not pull the
    // panel to Tasks mid-action and hide the result. The tab goes once the
    // owner leaves it (supervisorTabLeft).
    available = hasSupervisor || OverlayState.shared.tab == .supervisor
    OverlayState.shared.pruneFleetContext(openIDs: open)
    if state.running { recheckWhileRunning() }
  }

  /// No supervisor on this daemon at all: no tab, even mid-visit.
  private func clearState() {
    generation &+= 1
    questions = []
    status = nil
    notes = [:]
    stillSending = []
    sendingDeadline = [:]
    hasSupervisor = false
    available = false
    OverlayState.shared.selectTab(.tasks)
    OverlayState.shared.pruneFleetContext(openIDs: [])
  }

  /// The owner switched to Tasks: a supervisor with nothing to show loses
  /// its tab now, not while they were reading it.
  func supervisorTabLeft() {
    if !hasSupervisor { available = false }
  }

  private func recheckWhileRunning() {
    guard runningRecheck == nil else { return }
    runningRecheck = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let self else { return }
      self.runningRecheck = nil
      // Only worth a request while someone is looking at the tab.
      guard OverlayState.shared.expanded, OverlayState.shared.tab == .supervisor else { return }
      await self.refresh()
    }
  }

  /// True when this outreach item is the main's copy of one of this
  /// supervisor's open questions, which the Supervisor tab lists itself.
  /// Matched by id: another node's questions stay on the Tasks tab.
  func lists(_ item: OutreachItem) -> Bool {
    Self.lists(item, available: available, openIDs: Set(questions.map(\.id)))
  }

  /// The tab that shows these outreach items: Supervisor only when every one
  /// the Tasks tab would list is a question the Supervisor tab has instead.
  /// Approvals ("pending-action") show above both tabs.
  func tab(showing items: [OutreachItem]) -> OverlayTab {
    Self.tab(showing: items, available: available, openIDs: Set(questions.map(\.id)))
  }

  static func lists(_ item: OutreachItem, available: Bool, openIDs: Set<String>) -> Bool {
    guard available, item.type == "fleet-question", item.sourceKind == "fleet",
          let id = item.sourceId else { return false }
    return openIDs.contains(id)
  }

  static func tab(showing items: [OutreachItem], available: Bool, openIDs: Set<String>) -> OverlayTab {
    let listed = items.filter { $0.type != "pending-action" }
    let allListed = listed.allSatisfy { lists($0, available: available, openIDs: openIDs) }
    return !listed.isEmpty && allListed ? .supervisor : .tasks
  }

  /// A network or server failure on a refresh. Silent while the tab is
  /// hidden: most installs have no supervisor, and that is not an error.
  private func refreshFailed() {
    if available { setRefreshError("Couldn't reach the supervisor.") }
  }

  private func setRefreshError(_ message: String?) {
    if let message {
      lastError = message
      refreshOwnsError = true
    } else if refreshOwnsError {
      lastError = nil
      refreshOwnsError = false
    }
  }

  private func setActionError(_ message: String) {
    lastError = message
    refreshOwnsError = false
  }

  private func request(path: String, method: String, timeout: TimeInterval) -> URLRequest {
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: path))
    req.httpMethod = method
    req.timeoutInterval = timeout
    if method != "GET" { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return req
  }

  // MARK: - Pure helpers (unit-tested)

  /// What an answer or dismissal did, in the owner's words. `isError` rows
  /// render red: the question is still open and nothing reached the agent.
  static func outcome(_ response: FleetQuestionResponse?, dismissed: Bool) -> (text: String, isError: Bool) {
    if dismissed { return ("Dismissed.", false) }
    let detail = response?.delivery?.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
    let shownDetail = (detail?.isEmpty ?? true) ? nil : detail.map { String($0.prefix(300)) }
    let deliveryStatus = response?.delivery?.status
    if deliveryStatus == "queued" {
      return (shownDetail ?? "Saved. It goes to the agent once the Mac can type.", false)
    }
    // Blocked, failed, or "open thread": the supervisor hands it back.
    if response?.question?.status == "open" {
      return (shownDetail ?? "Not sent yet. The question is still open.", true)
    }
    switch deliveryStatus {
    case "sent": return ("Sent to the agent.", false)
    case "dry-run": return ("Saved. Dry run, nothing sent.", false)
    default: return ("Answered.", false)
    }
  }

  /// The Supervisor tab's one status line: "Scanned 4m ago · Propose mode".
  /// The open count is on the tab itself, so it is not repeated here.
  static func statusLine(_ status: FleetStatus, now: Date = Date()) -> String {
    var parts: [String] = []
    if status.running {
      parts.append("Scanning now")
    } else if let at = status.lastTickAt.flatMap(parseDate) {
      parts.append("Scanned \(relative(at, now: now))")
    } else {
      parts.append("Not scanned yet")
    }
    if !status.mode.isEmpty { parts.append(status.mode.prefix(1).uppercased() + status.mode.dropFirst() + " mode") }
    if !status.enabled { parts.append("auto-scan off") }
    return parts.joined(separator: " · ")
  }

  /// A question's age beside its title: "now", "12m", "3h", "2d".
  static func age(_ createdAt: String?, now: Date = Date()) -> String? {
    guard let at = createdAt.flatMap(parseDate) else { return nil }
    return compactAge(seconds(since: at, now: now))
  }

  private static func relative(_ date: Date, now: Date) -> String {
    let elapsed = seconds(since: date, now: now)
    return elapsed < 60 ? "just now" : "\(compactAge(elapsed)) ago"
  }

  private static func seconds(since date: Date, now: Date) -> Int {
    max(0, Int(now.timeIntervalSince(date)))
  }

  private static func compactAge(_ seconds: Int) -> String {
    if seconds < 60 { return "now" }
    if seconds < 3_600 { return "\(seconds / 60)m" }
    if seconds < 86_400 { return "\(seconds / 3_600)h" }
    return "\(seconds / 86_400)d"
  }

  /// A question named in the panel-wide line: its title, in quotes, short.
  private static func named(_ question: FleetQuestion) -> String {
    let title = question.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\u{201C}\(title.count > 60 ? String(title.prefix(59)) + "\u{2026}" : title)\u{201D}"
  }

  private static func parseDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
  }

  private static func serverError(_ data: Data) -> String? {
    guard let message = (try? JSONDecoder().decode(FleetErrorBody.self, from: data))?.error?
      .trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty else { return nil }
    return String(message.prefix(300))
  }
}
