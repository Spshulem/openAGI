import Foundation
import SwiftUI
import UserNotifications

// Single source of truth for menubar state. Health, recent activity, budget,
// and audit findings poll from the daemon's HTTP API. Auth token is loaded
// from the env file the wizard wrote on first run.

@MainActor
final class AppState: ObservableObject {
  static let shared = AppState()

  // Daemon connection
  let baseURL: URL = URL(string: "http://127.0.0.1:43210")!
  @Published var status: HealthStatus = .unknown

  // Health snapshot
  @Published var providerName: String = "—"
  // Missing health data is unknown, not evidence that a saved key disappeared.
  @Published var providerConfigured: Bool? = nil
  var providerSetupStatus: ProviderSetupStatus {
    ProviderSetupStatus.resolve(
      daemonResponding: status != .unknown && status != .down,
      configured: providerConfigured
    )
  }
  @Published var memoryShort: Int = 0
  @Published var memoryMedium: Int = 0
  @Published var memoryLong: Int = 0
  @Published var spentToday: Double = 0
  @Published var spentLimit: Double = 10
  @Published var findings: [Finding] = []
  @Published var recentSessions: [SessionSummary] = []
  @Published var topTasks: [TaskSummary] = []
  @Published var paused: Bool = false

  // Remote "main" pointer for proactive outreach. When set, OutreachConsumer
  // points at this URL/token (a separate host from the local daemon above) and
  // durably pulls the outreach feed. Persisted in UserDefaults; the wizard or a
  // `defaults write` seeds it.
  @Published var outreachRemoteURL: String = UserDefaults.standard.string(forKey: "outreachRemoteURL") ?? ""
  @Published var outreachToken: String = UserDefaults.standard.string(forKey: "outreachToken") ?? ""

  func setOutreachMain(url: String, token: String) {
    outreachRemoteURL = url
    outreachToken = token
    UserDefaults.standard.set(url, forKey: "outreachRemoteURL")
    UserDefaults.standard.set(token, forKey: "outreachToken")
    OutreachConsumer.shared.reconfigure(url: url, token: token)
  }

  // Remote capture target. Empty means the local daemon, preserving the
  // existing default. Seed with defaults write app.openagi.daemon daemonBaseURL.
  @Published var captureRemoteURL: String = UserDefaults.standard.string(forKey: "daemonBaseURL") ?? ""
  @Published var captureRemoteToken: String = UserDefaults.standard.string(forKey: "daemonToken") ?? ""

  func setCaptureMain(url: String, token: String) {
    captureRemoteURL = url
    captureRemoteToken = token
    UserDefaults.standard.set(url, forKey: "daemonBaseURL")
    UserDefaults.standard.set(token, forKey: "daemonToken")
  }

  // Stable per-install machine id stamped on every observation batch so a
  // main receiving capture from several nodes can tell the streams apart.
  nonisolated static func sourceMachineId() -> String {
    let key = "sourceMachineId"
    if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty { return existing }
    let fresh = UUID().uuidString
    UserDefaults.standard.set(fresh, forKey: key)
    return fresh
  }

  private var pollTimer: Timer?
  private var sseTask: URLSessionDataTask?
  private var sseSession: URLSession?

  enum HealthStatus { case unknown, healthy, degraded, down }

  /// Why the daemon is unreachable. `.serving` while /health answers.
  ///
  /// `status == .down` is set by any failed /health fetch, so on its own it
  /// cannot tell "the process is gone" from "the process is alive, still owns
  /// port 43210, and stopped answering". The user hit the second case for 25
  /// hours — daemon in process state T, socket LISTENing, /health timing out —
  /// and the tray could only say "daemon offline", which is false for a running
  /// process and points at the wrong fix. A wedged daemon needs its port holder
  /// force-quit before a respawn can bind; a missing one just needs starting.
  enum DaemonReachability { case serving, notRunning, notResponding }
  @Published var reachability: DaemonReachability = .serving
  /// Cached by pollOnce so SwiftUI never launches `lsof` while rendering the
  /// tray menu. restart(force:) still revalidates ownership synchronously at
  /// the moment the user clicks, before it signals any listener.
  @Published var daemonManagedExternally: Bool = false

  @Published var lastError: String? = nil
  @Published var consecutiveFailures: Int = 0

  struct Finding: Identifiable, Codable {
    var id: String { "\(severity):\(area):\(note)" }
    let severity: String
    let area: String
    let note: String
  }

  struct SessionSummary: Identifiable, Codable {
    var id: String { sessionId }
    let sessionId: String
    let lastMessage: String
    let updatedAt: String
    enum CodingKeys: String, CodingKey {
      case sessionId = "id"
      case lastMessage
      case updatedAt
    }
  }

  struct TaskSummary: Identifiable, Codable {
    let id: String
    let title: String
    let bucket: String
    let priority: Int
    let queue: String
    let source: String?
    let sourceUrl: String?
  }

  struct TasksResponse: Codable {
    let tasks: [TaskSummary]?
  }

  // MARK: — Auth

  func authToken() -> String? {
    if let env = ProcessInfo.processInfo.environment["OPENAGI_AUTH_TOKEN"], !env.isEmpty { return env }
    return Self.readEnvFile()["OPENAGI_AUTH_TOKEN"]
  }

  static func readEnvFile() -> [String: String] {
    let path = dataDir().appendingPathComponent(".env")
    guard let text = try? String(contentsOf: path, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for raw in text.split(separator: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty, !line.hasPrefix("#"), let eq = line.firstIndex(of: "=") else { continue }
      let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
      let val = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
      out[key] = val
    }
    return out
  }

  // Non-isolated so DaemonController (and any future non-main-actor code) can call it.
  nonisolated static func dataDir() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let dir = home.appendingPathComponent(".openagi", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  // MARK: — Polling

  func startPolling() {
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { await self?.pollOnce() }
    }
    Task { await pollOnce() }
  }

  func stopPolling() {
    pollTimer?.invalidate()
    pollTimer = nil
  }

  // Latched per launch: a fresh install gets walked to the setup wizard
  // exactly once instead of sitting silent behind a menubar icon. (The
  // single biggest onboarding failure was the app launching, starting an
  // unconfigured daemon, and never showing the user ANYTHING.)
  private var offeredSetupThisLaunch = false

  private func pollOnce() async {
    // Always probe /health on its own so we can distinguish "daemon is dead"
    // from "daemon is up but /audit is throwing".
    do {
      // 4s, not URLSession's 60s default. A wedged-but-listening daemon still
      // completes the TCP handshake out of the kernel's accept queue and then
      // never answers, so the default leaves this request hanging for a full
      // minute — during which the tray keeps showing the last good status
      // ("● online") for a daemon serving nothing, while the 5s timer stacks a
      // dozen more doomed requests behind it. A wedged daemon reported as
      // healthy is the worst state this surface can be in. Under the poll
      // interval, so a wedge shows up on the next tick; local /health answers
      // in ~0.3s, so the headroom is ~13x.
      let h: HealthResponse = try await get("/health", timeout: 4)
      let recoveredFromOutage = consecutiveFailures > 0
      status = computeStatus(h)
      reachability = .serving
      daemonManagedExternally = await DaemonController.shared.listenerOwnership() == .external
      providerName = h.status?.agentHost?.provider ?? "—"
      providerConfigured = h.status?.agentHost?.providerConfigured
      memoryShort = h.status?.memory?.short ?? 0
      memoryMedium = h.status?.memory?.medium ?? 0
      memoryLong = h.status?.memory?.long ?? 0
      lastError = nil
      consecutiveFailures = 0
      // First successful /health of the launch — now, and not before, the
      // daemon is definitely up and serving. The collapsed pill's badge counts
      // brief items, so without this it reads 0 until the user opens the
      // popover: the one always-visible "something needs you" signal was blank
      // exactly when there was something to see.
      if !didInitialBriefRefresh || recoveredFromOutage {
        didInitialBriefRefresh = true
        scheduleBriefRefresh()
        // SSE notifications emitted while disconnected are not replayed.
        // Reconcile durable approvals on recovery, without requiring the user
        // to close and reopen a panel that still displays an outage error.
        Task { await PendingApprovalConsumer.shared.refresh() }
      }
      if h.firstRun == true && !offeredSetupThisLaunch {
        offeredSetupThisLaunch = true
        notify(title: "Welcome to OpenAGI", body: "Two minutes of setup and your agent is live.", path: "/setup")
        openDashboard(path: "/setup")
      } else if h.firstRun != true && providerSetupStatus == .needsSetup && !offeredSetupThisLaunch {
        // Partially-configured install (auth token saved, model key missing —
        // isFirstRun() is false but the agent can't think). Nudge once per
        // launch with a notification only; don't grab a window from someone
        // who may be running deterministic-only on purpose.
        offeredSetupThisLaunch = true
        notify(title: "OpenAGI needs a model key", body: "The agent is running without an LLM. Tap to finish setup.", path: "/setup")
      }
    } catch {
      status = .down
      lastError = "/health: \(error.localizedDescription)"
      consecutiveFailures += 1
      // Alive and holding the port, or actually gone? See DaemonReachability —
      // the tray says different things and offers different actions for each.
      switch await DaemonController.shared.listenerOwnership() {
      case .none:
        reachability = .notRunning
        daemonManagedExternally = false
      case .managed:
        reachability = .notResponding
        daemonManagedExternally = false
      case .external:
        reachability = .notResponding
        daemonManagedExternally = true
      }
      if consecutiveFailures == 3 {
        notify(title: "OpenAGI offline", body: lastError ?? "Daemon stopped responding.", path: "/")
      }
      // Auto-recover: once /health has failed 3+ consecutive polls (~15s at the
      // 5s poll interval) the daemon is not coming back on its own. Restart it,
      // at most once a minute so a fundamentally broken daemon (port conflict,
      // missing entitlement) doesn't get respawned in a tight loop.
      //
      // `>=`, not `==`. consecutiveFailures only resets on a SUCCESSFUL /health,
      // so during an outage it climbs 1,2,3,4,… monotonically and an equality
      // test matches at most once. If that single instant fell inside the 60s
      // throttle window, the recovery path never ran again for the rest of the
      // outage however long it lasted — and if the one restart it did get failed
      // to take, likewise. The cap advertised here was one per minute; what
      // shipped was at most one per outage, sometimes zero.
      //
      // The throttle reads DaemonController's own stamp rather than a clock
      // private to AppState, so a restart the USER just triggered from the tray
      // also holds this off — otherwise the poller would kill their booting
      // daemon 15s in, every time.
      if consecutiveFailures >= 3,
         Date().timeIntervalSince(DaemonController.shared.lastRestartAt) > 60 {
        NSLog("OpenAGI: daemon /health failing — auto-restarting")
        // force: 3 failed health polls is enough evidence to replace a bundled
        // daemon this app no longer has a Process handle for. DaemonController
        // still refuses to terminate externally managed listeners.
        DaemonController.shared.restart(force: true)
      }
      return
    }

    // Sub-fetches: any of these can fail (e.g. dashboard render bug, FTS db
    // contention) without meaning the daemon is offline. Capture the error
    // so the tray can still show what's wrong.
    do {
      let b: BudgetResponse = try await get("/budget")
      spentToday = b.spentUsd ?? 0
      spentLimit = b.dailyUsdLimit ?? 10
    } catch {
      lastError = "/budget: \(error.localizedDescription)"
      status = (status == .healthy) ? .degraded : status
    }
    do {
      let a: AuditResponse = try await get("/audit")
      findings = a.findings ?? []
    } catch {
      lastError = "/audit: \(error.localizedDescription)"
      status = (status == .healthy) ? .degraded : status
    }
    do {
      let sessions: [SessionSummary] = try await get("/sessions")
      recentSessions = Array(sessions.prefix(5))
    } catch {
      // Quietly skip; not critical.
    }
    do {
      let r: TasksResponse = try await get("/tasks?queue=user&status=pending&limit=5")
      topTasks = Array((r.tasks ?? []).prefix(5))
    } catch {
      // Quietly skip; not critical.
    }
    if status != .healthy { Task { await self.fetchAuditAndNotify() } }
  }

  private func computeStatus(_ h: HealthResponse) -> HealthStatus {
    guard h.ok == true else { return .down }
    let warnings = (h.status?.outcomes?.last7Days?.avgQuality ?? 1) < 0.45
    let budgetPct = spentLimit > 0 ? spentToday / spentLimit : 0
    if warnings || budgetPct > 0.7 || (findings.contains { $0.severity == "warn" || $0.severity == "err" }) {
      return .degraded
    }
    return .healthy
  }

  // MARK: — Live event stream (notifications)

  func startSSE() {
    sseTask?.cancel()
    let url = baseURL.appendingPathComponent("events")
    var req = URLRequest(url: url)
    if let token = authToken() {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 0
    cfg.timeoutIntervalForResource = 0
    let session = URLSession(configuration: cfg, delegate: SSEDelegate.shared, delegateQueue: .main)
    sseSession = session
    sseTask = session.dataTask(with: req)
    sseTask?.resume()
  }

  func stopSSE() {
    sseTask?.cancel()
    sseSession?.invalidateAndCancel()
  }

  // MARK: — Brief refresh

  /// SSE events that can change what `GET /brief/today` ranks. The brief is
  /// composed from the plan cache, the task store, the draft store, the
  /// clarification store and the suggestion feed (src/daily-brief.js), so any
  /// event that mutates one of those invalidates both the popover's list and
  /// the collapsed pill's badge. Names taken verbatim from the broadcast list
  /// in src/hosted-interface.js — nothing here is invented.
  ///
  /// Deliberately excluded: "task-reminder" and "daily-recap" are pure
  /// notifications over unchanged state, and refetching on them would just
  /// burn a request.
  private static let briefRelevantEvents: Set<String> = [
    "proactive-suggestion",
    "suggestion-resolved",
    "task-updated",
    "task-auto-changed",
    "task-unblocked",
    "clarification-created",
    "clarification-resolved",
    "draft-created",
    "draft-resolved",
    "daily-plan"
  ]

  private var briefRefreshTask: Task<Void, Never>?
  private var briefRefreshPending = false
  private var didInitialBriefRefresh = false

  /// Coalesce brief refetches. These events arrive in bursts — one planner run
  /// emits a daily-plan plus a task-updated per task it touched — and they all
  /// want the same single GET. Trailing-edge debounce (~1s), with a 3s ceiling
  /// so a steady drip of events can't defer the refresh forever.
  func scheduleBriefRefresh() {
    briefRefreshPending = true
    guard briefRefreshTask == nil else { return }   // the open window will pick it up
    briefRefreshTask = Task { [self] in
      let start = Date()
      while true {
        briefRefreshPending = false
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if Task.isCancelled { briefRefreshTask = nil; return }
        // Nothing new landed during the window, or we've deferred long enough.
        if !briefRefreshPending || Date().timeIntervalSince(start) >= 3 { break }
      }
      // Clear BEFORE the fetch: an event arriving mid-request must be able to
      // open a fresh window rather than being swallowed by this one.
      briefRefreshTask = nil
      briefRefreshPending = false
      await BriefConsumer.shared.refresh()
    }
  }

  func handleSSEEvent(_ event: String, _ data: String) {
    // The brief is server-composed, so a change to any of its sources means the
    // ranking may have moved — refetch rather than mutating local state.
    if Self.briefRelevantEvents.contains(event) { scheduleBriefRefresh() }
    if event == "cron", data.contains("\"op\":\"run\"") {
      notify(title: "OpenAGI", body: "Scheduled job fired.", path: "/")
    }
    if event == "mcp" { Task { await pollOnce() } }
    if event == "message" { Task { await pollOnce() } }
    if event == "skill-candidate" {
      // Pattern miner / session miner proposed a new skill — surface it.
      let parsed = parseSkillCandidate(data)
      let title = "OpenAGI learned a new skill"
      let body: String = {
        let name = parsed.name ?? "untitled"
        if let desc = parsed.description, !desc.isEmpty { return "\(name) — \(desc)" }
        return name
      }()
      notify(title: title, body: body, path: "/?tab=skills")
    }
    if event == "task-reminder" {
      // Morning digest or due-date reminder — fire native notification.
      let title = parseField(data, "title") ?? "OpenAGI"
      let body = parseField(data, "body") ?? ""
      notify(title: title, body: body, path: "/?tab=tasks")
    }
    if event == "proactive-suggestion" {
      // Proactive observer noticed something. Tap → chat tab with the
      // suggestion's id passed through, so chat can render an inline
      // approve/dismiss card AND seed the input with a sensible draft
      // ("yes, add it"). User stays in conversation rather than getting
      // bounced to a separate Suggestions tab.
      let parsed = parseSkillCandidate(data)
      let category = parseField(data, "category") ?? "fyi"
      let prefix: String = {
        switch category {
        case "task": return "📋 Task idea"
        case "mcp": return "🔌 Connect"
        case "skill": return "✨ Skill idea"
        case "automation": return "⚙️ Auto"
        case "knowledge": return "💡 FYI"
        default: return "🔔"
        }
      }()
      // The payload sends title/rationale (src/proactive-observer.js:300-306);
      // parseSkillCandidate reads name/description, which are absent here, so
      // this fell through to the placeholder for every suggestion ever sent.
      let suggestionTitle = parseField(data, "title") ?? parsed.name ?? "OpenAGI noticed something"
      let title = "\(prefix): \(suggestionTitle)"
      let body = parseField(data, "rationale") ?? parsed.description ?? "Tap to review in chat."
      let suggestionId = parseField(data, "id") ?? ""
      let pathPart = suggestionId.isEmpty ? "/?tab=chat" : "/?tab=chat&suggestion=\(urlEncode(suggestionId))"
      notify(title: title, body: body, path: pathPart)
      // (the brief refetch is handled by briefRelevantEvents at the top)
    }
    if event == "daily-recap" {
      // Story 7: evening "what did you get done today" notification.
      // Tap routes to the Today tab; data has the markdown loaded.
      let title = parseField(data, "title") ?? "Today's recap"
      let body = parseField(data, "body") ?? "Tap to see what you got done."
      let date = parseField(data, "date") ?? ""
      let pathPart = date.isEmpty ? "/?tab=today" : "/?tab=today&date=\(urlEncode(date))"
      notify(title: title, body: body, path: pathPart)
    }
    if event == "daily-plan" {
      // Morning "here's your day" notification (calendar + focus + what the
      // agent will draft). Tap routes to the Tasks tab.
      let title = parseField(data, "title") ?? "Your day"
      let body = parseField(data, "body") ?? "Tap to see today's plan."
      notify(title: title, body: body, path: "/?tab=tasks")
    }
    if event == "pending-action" {
      // Agent queued something that needs approval (gated tool). Reconcile the
      // durable queue and expand Quick Ask so the user can decide right in the
      // floating surface; the native notification remains a second route.
      let summary = parseField(data, "summary") ?? "Agent action awaiting approval"
      let actionId = parseField(data, "id") ?? ""
      let pathPart = actionId.isEmpty ? "/?tab=chat" : "/?tab=chat&pending=\(urlEncode(actionId))"
      Task { await PendingApprovalConsumer.shared.refresh() }
      OverlayController.shared.show()
      OverlayState.shared.expanded = true
      notify(title: "🤖 Agent wants to: \(summary)", body: "Tap to approve or deny.", path: pathPart)
    }
    if event == "pending-action-resolved" {
      Task { await PendingApprovalConsumer.shared.refresh() }
    }
    if event == "computer-use" {
      PendingApprovalConsumer.shared.handleComputerUseEvent(data)
    }
  }

  private func urlEncode(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
  }

  private func parseField(_ data: String, _ key: String) -> String? {
    guard let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else {
      return nil
    }
    return json[key] as? String
  }

  private func parseSkillCandidate(_ data: String) -> (name: String?, description: String?) {
    guard let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else {
      return (nil, nil)
    }
    return (json["name"] as? String, json["description"] as? String)
  }

  // Tracks whether we've already fired the budget notification for the current
  // over-cap episode. pollOnce() calls fetchAuditAndNotify() every ~5s while
  // degraded, so without this latch the budget warning notifies on every poll
  // (spam once spend crosses 70%). Re-armed when spend drops back under the cap
  // (or resets at day rollover).
  private var budgetNotified = false

  private func fetchAuditAndNotify() async {
    let budgetWarn = findings.contains { $0.severity == "warn" && $0.area == "budget" }
    if budgetWarn {
      if !budgetNotified {
        notify(title: "OpenAGI budget", body: "Today's spend > 70% of daily cap.", path: "/")
        budgetNotified = true
      }
    } else {
      budgetNotified = false
    }
  }

  // MARK: — Actions

  func openDashboard(path: String = "/") {
    // path may already carry a query (e.g. "/?tab=chat&suggestion=abc"), so
    // we have to merge ?token correctly — otherwise URL becomes
    // "/?tab=chat&suggestion=abc?token=…" which the browser reads as
    // a single query name, breaks the tab routing, and lands on chat
    // with no context.
    let token = authToken() ?? ""
    let separator: String = path.contains("?") ? "&" : "?"
    let urlString = "http://127.0.0.1:43210\(path)\(separator)token=\(token)"
    if let url = URL(string: urlString) {
      NSWorkspace.shared.open(url)
    }
  }

  func notify(title: String, body: String, path: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.userInfo = ["path": path]
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req)
  }

  struct MessageReply: Decodable {
    let reply: String?
    let session: SessionRef?
    struct SessionRef: Decodable { let id: String? }
  }

  private struct OverlayStreamStatus: Decodable {
    let stage: String?
  }

  private struct OverlayStreamSession: Decodable {
    let id: String?
  }

  private struct OverlayStreamDelta: Decodable {
    let text: String
    let reset: Bool?
  }

  private struct OverlayStreamFailure: Decodable {
    let error: String?
    let code: String?
    let sessionId: String?
  }

  nonisolated static func requestMayStillBeRunning(after error: Error) -> Bool {
    let ns = error as NSError
    return ns.domain == NSURLErrorDomain || ns.domain == "OpenAGI.Transport"
  }

  /// Server-side session id of the most recent successful overlay ask.
  ///
  /// POST /message is a normal, fully persisted turn: agent-store's
  /// sessionKey({channel:"overlay", from:"user", agentId:"main"}) resolves to
  /// "overlay:user:main" and both the question and the answer are written to
  /// the file-backed session store before the reply comes back. So the popover
  /// already HAS a real conversation — it just never told anyone which one.
  /// The overlay's "Continue in chat" reads this to deep-link to that exact
  /// session instead of opening an empty composer.
  @Published var lastAskSessionId: String? = nil
  /// Correlates the currently visible Quick Ask turn with daemon progress.
  /// It is persisted on the user message, so the dashboard can distinguish a
  /// genuinely pending turn from an old conversation that simply ended with a
  /// user message.
  @Published var lastAskRequestId: String? = nil

  /// Reserve the durable ids synchronously, before focused-window capture.
  /// OverlayState flips `isLoading` before capture starts, so without this tiny
  /// preflight the working-state handoff button has a brief window where it can
  /// only open an unrelated blank chat.
  @discardableResult
  func beginOverlayAsk() -> String {
    if lastAskSessionId == nil { lastAskSessionId = "overlay:user:main" }
    let requestId = "ask_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    lastAskRequestId = requestId
    return requestId
  }

  // Send a question to the agent from the floating widget, attaching fresh
  // focused-window context. Returns the agent's reply text.
  func askOverlay(
    text: String,
    screenContext: ScreenContext?,
    briefContext: BriefChatContext? = nil,
    requestId preparedRequestId: String? = nil,
    onProgress: ((String) -> Void)? = nil,
    onTextDelta: ((String, Bool) -> Void)? = nil
  ) async throws -> String {
    // Name the durable conversation BEFORE opening the request. The model may
    // use several tool hops and outlive a compact-window HTTP timeout; knowing
    // the id up front keeps "Continue in main app" honest during work and after
    // any client-side disconnect. Explicit sessionId also prevents specialist
    // routing from silently moving this turn to an id the popup cannot predict.
    let sessionId = lastAskSessionId ?? "overlay:user:main"
    let requestId = preparedRequestId ?? beginOverlayAsk()
    lastAskSessionId = sessionId
    lastAskRequestId = requestId

    var meta: [String: Any] = [:]
    if let s = screenContext, !s.text.isEmpty {
      var sc: [String: Any] = ["app": s.app, "text": s.text]
      if let w = s.window { sc["window"] = w }
      meta["screenContext"] = sc
    }
    if let briefContext { meta["briefContext"] = briefContext.jsonObject }
    meta["requestId"] = requestId
    meta["requestSource"] = "overlay"
    let payload: [String: Any] = [
      "text": text,
      "channel": "overlay",
      "from": "user",
      "agentId": "main",
      "sessionId": sessionId,
      "metadata": meta
    ]
    let body = try JSONSerialization.data(withJSONObject: payload)
    return try await streamOverlayMessage(body: body, onProgress: onProgress, onTextDelta: onTextDelta)
  }

  /// Consume POST /message's opt-in SSE response. Status and heartbeat frames
  /// keep the small popup alive while long tool runs proceed; `final` is the
  /// exact legacy JSON response. If an older daemon ignores the Accept header,
  /// its ordinary JSON body is decoded as a compatibility fallback.
  private func streamOverlayMessage(
    body: Data,
    onProgress: ((String) -> Void)?,
    onTextDelta: ((String, Bool) -> Void)?
  ) async throws -> String {
    var req = URLRequest(url: Self.buildURL(base: baseURL, path: "/message"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    req.httpBody = body

    let (bytes, response) = try await URLSession.shared.bytes(for: req)
    guard let http = response as? HTTPURLResponse else {
      throw NSError(domain: "OpenAGI.Transport", code: -1, userInfo: [NSLocalizedDescriptionKey: "The daemon returned an invalid response."])
    }

    let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
    if !contentType.contains("text/event-stream") {
      var data = Data()
      for try await byte in bytes { data.append(byte) }
      try Self.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(MessageReply.self, from: data)
      if let id = decoded.session?.id, !id.isEmpty { lastAskSessionId = id }
      return decoded.reply ?? "(no reply)"
    }

    guard (200..<300).contains(http.statusCode) else {
      throw NSError(domain: "OpenAGI", code: http.statusCode, userInfo: [
        NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"
      ])
    }

    var parser = ServerSentEventParser()
    for try await line in bytes.lines {
      guard let event = parser.consume(line: line) else { continue }
      let data = Data(event.data.utf8)
      switch event.name {
      case "status":
        if let status = try? JSONDecoder().decode(OverlayStreamStatus.self, from: data),
           let stage = status.stage, !stage.isEmpty {
          onProgress?(stage)
        }
      case "heartbeat":
        // A heartbeat proves the daemon is still working even when no new
        // token/tool stage has landed. Preserve the named stage if supplied.
        if let status = try? JSONDecoder().decode(OverlayStreamStatus.self, from: data),
           let stage = status.stage, !stage.isEmpty {
          onProgress?(stage)
        }
      case "session":
        if let session = try? JSONDecoder().decode(OverlayStreamSession.self, from: data),
           let id = session.id, !id.isEmpty {
          lastAskSessionId = id
        }
      case "delta":
        // The daemon allowlists visible assistant text before emitting this
        // frame. Tool inputs/results and provider reasoning never cross it.
        if let delta = try? JSONDecoder().decode(OverlayStreamDelta.self, from: data),
           !delta.text.isEmpty {
          onTextDelta?(delta.text, delta.reset == true)
        }
      case "final":
        let decoded = try JSONDecoder().decode(MessageReply.self, from: data)
        if let id = decoded.session?.id, !id.isEmpty { lastAskSessionId = id }
        return decoded.reply ?? "(no reply)"
      case "failure":
        let failure = try? JSONDecoder().decode(OverlayStreamFailure.self, from: data)
        if let id = failure?.sessionId, !id.isEmpty { lastAskSessionId = id }
        let message = failure?.error ?? "The agent could not complete that request."
        throw NSError(domain: "OpenAGI.Agent", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
      default:
        continue
      }
    }
    throw NSError(domain: "OpenAGI.Transport", code: -1, userInfo: [
      NSLocalizedDescriptionKey: "The connection ended before completion was confirmed."
    ])
  }

  /// Open the dashboard's chat tab ON a specific server-side session.
  ///
  /// Deep-linking the session id (rather than replaying the question and answer
  /// through the URL) is what makes the handoff lossless: the dashboard refetches
  /// GET /sessions/:id, so the full history comes across, an answer of any length
  /// survives (a URL would not hold a 6KB reply), and the screenContext attached
  /// to the turn is still on the message for the chat tab to show.
  ///
  /// Without an id we do NOT pretend: the plain chat tab opens, same as before.
  /// That path is only reachable if the daemon answered 200 without naming a
  /// session, which today it never does.
  func openChatSession(_ sessionId: String?, requestId: String? = nil) {
    guard let id = sessionId, !id.isEmpty else {
      openDashboard(path: "/?tab=chat")
      return
    }
    var path = "/?tab=chat&session=" + Self.queryValueEncoded(id)
    if let requestId, !requestId.isEmpty {
      path += "&request=" + Self.queryValueEncoded(requestId)
    }
    openDashboard(path: path)
  }

  /// Percent-encode a string being spliced in as a query-parameter VALUE.
  /// `.urlQueryAllowed` (what `urlEncode` above uses) permits "&", "=", "+"
  /// and "#" because they are legal *somewhere* in a query — but inside a
  /// single value they mean "next parameter", "key/value split", "space"
  /// (URLSearchParams decodes "+" as a space) and "start of fragment". A
  /// session id is "channel:from:agentId" with a caller-supplied `from`, so
  /// those bytes are reachable. ":" is deliberately left alone: it is legal in
  /// a query, URLSearchParams returns it verbatim, and it keeps the link
  /// readable as "session=overlay:user:main".
  nonisolated static func queryValueEncoded(_ s: String) -> String {
    let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#;"))
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
  }

  func togglePause() async {
    paused.toggle()
    let path = paused ? "/admin/pause" : "/admin/resume"
    _ = try? await post(path)
  }

  // MARK: — HTTP helpers

  /// Build a request URL from a daemon path that MAY carry a query string.
  /// `URL.appendingPathComponent` percent-encodes "?" (so "/tasks?queue=user"
  /// becomes "/tasks%3Fqueue=user" and 404s), which silently emptied every
  /// query-string fetch in this file. Split the query off and let
  /// URLComponents own it.
  /// Assigning the raw split verbatim to `percentEncodedQuery` is a loaded gun:
  /// that setter is a precondition, not a throwing API, so one unencoded byte
  /// (a space in "?q=hello world") aborts the whole app. Sanitise first.
  /// The path half needs the same care for the opposite reason:
  /// `appendingPathComponent` treats its argument as a LITERAL segment and
  /// re-encodes "%", so a server-emitted "/drafts/a%2Fb/approve" would go out as
  /// "/drafts/a%252Fb/approve" and 404 — src/daily-brief.js wraps every id in
  /// encodeURIComponent, so its escapes must survive verbatim. `percentEncodedPath`
  /// preserves them, and is likewise a precondition setter, so it gets sanitised too.
  nonisolated static func buildURL(base: URL, path: String) -> URL {
    let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let rawPath = String(parts.first ?? "")
    var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
    var basePath = comps?.percentEncodedPath ?? ""
    while basePath.hasSuffix("/") { basePath.removeLast() }
    let joined = rawPath.isEmpty ? basePath : basePath + (rawPath.hasPrefix("/") ? rawPath : "/" + rawPath)
    // `joined` is empty only for the degenerate path "" / "?q=1"; "/" keeps those
    // byte-identical to what appendingPathComponent used to produce.
    comps?.percentEncodedPath = sanitizedPercentEncodedPath(joined.isEmpty ? "/" : joined)
    if parts.count > 1, !parts[1].isEmpty {
      comps?.percentEncodedQuery = sanitizedPercentEncodedQuery(String(parts[1]))
    }
    return comps?.url ?? base.appendingPathComponent(rawPath)
  }

  /// Make any caller-supplied query string safe to hand to `percentEncodedQuery`.
  /// Escapes already present are preserved byte-for-byte (re-encoding them would
  /// turn "%20" into "%2520" and "%26" into a literal "&", changing the request),
  /// anything outside the RFC 3986 query set is percent-encoded, and a stray "%"
  /// that does not introduce a valid escape becomes "%25". The result therefore
  /// contains only characters the setter accepts, so it can never abort.
  nonisolated static func sanitizedPercentEncodedQuery(_ raw: String) -> String {
    sanitizedPercentEncoded(raw, allowed: .urlQueryAllowed)
  }

  /// The `percentEncodedPath` counterpart. Same contract, path character set —
  /// and one extra rule the setter enforces: with an authority component present
  /// (we always have host:port) the path must be empty or start with "/", so a
  /// caller path missing its leading slash gets one rather than aborting.
  nonisolated static func sanitizedPercentEncodedPath(_ raw: String) -> String {
    let cleaned = sanitizedPercentEncoded(raw, allowed: .urlPathAllowed)
    if cleaned.isEmpty || cleaned.hasPrefix("/") { return cleaned }
    return "/" + cleaned
  }

  /// Shared engine for both sanitizers above. `allowed` must be one of the URL
  /// component sets, all of which exclude "%" — which is handled explicitly here
  /// — so every branch emits a character the matching setter accepts.
  private nonisolated static func sanitizedPercentEncoded(_ raw: String, allowed: CharacterSet) -> String {
    func isASCIIHex(_ s: Unicode.Scalar) -> Bool {
      (s >= "0" && s <= "9") || (s >= "a" && s <= "f") || (s >= "A" && s <= "F")
    }
    let scalars = Array(raw.unicodeScalars)
    var out = ""
    out.reserveCapacity(scalars.count)
    var i = 0
    while i < scalars.count {
      let s = scalars[i]
      if s == "%" {
        if i + 2 < scalars.count, isASCIIHex(scalars[i + 1]), isASCIIHex(scalars[i + 2]) {
          out.unicodeScalars.append(contentsOf: scalars[i...(i + 2)])
          i += 3
        } else {
          out += "%25"
          i += 1
        }
        continue
      }
      // `allowed` is exactly the component's legal set minus "%", which is
      // handled above — so every branch here emits setter-legal characters.
      if allowed.contains(s) {
        out.unicodeScalars.append(s)
      } else {
        out += String(s).addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
      }
      i += 1
    }
    return out
  }

  /// Throw on any non-2xx so callers see a real error instead of decoding
  /// an error body into nil and rendering it as "(no reply)".
  nonisolated static func ensureOK(_ resp: URLResponse, _ data: Data) throws {
    guard let http = resp as? HTTPURLResponse else { return }
    guard (200..<300).contains(http.statusCode) else {
      let snippet = String(data: data.prefix(300), encoding: .utf8) ?? ""
      throw NSError(domain: "OpenAGI", code: http.statusCode, userInfo: [
        NSLocalizedDescriptionKey: "HTTP \(http.statusCode)\(snippet.isEmpty ? "" : ": \(snippet)")"
      ])
    }
  }

  /// `timeout` is opt-in: only /health passes one. The other polls are allowed
  /// URLSession's default, because a slow /audit on a big store is still a
  /// working daemon and capping it would turn slowness into a false error.
  private func get<T: Decodable>(_ path: String, timeout: TimeInterval? = nil) async throws -> T {
    var req = URLRequest(url: Self.buildURL(base: baseURL, path: path))
    if let timeout { req.timeoutInterval = timeout }
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func post(_ path: String, body: Data? = nil) async throws -> Data {
    var req = URLRequest(url: Self.buildURL(base: baseURL, path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body = body { req.httpBody = body }
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return data
  }
}

// MARK: — Decoding shapes

struct HealthResponse: Decodable {
  let ok: Bool?
  let firstRun: Bool?
  let status: HealthInner?
  struct HealthInner: Decodable {
    let agentHost: AgentHost?
    let memory: Memory?
    let outcomes: Outcomes?
    struct AgentHost: Decodable {
      let provider: String?
      let providerConfigured: Bool?
    }
    struct Memory: Decodable {
      let short: Int?; let medium: Int?; let long: Int?
    }
    struct Outcomes: Decodable {
      let last7Days: Aggregate?
      struct Aggregate: Decodable { let avgQuality: Double? }
    }
  }
}

struct BudgetResponse: Decodable {
  let spentUsd: Double?
  let dailyUsdLimit: Double?
}

struct AuditResponse: Decodable {
  let findings: [AppState.Finding]?
}
