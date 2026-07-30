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
  @Published var providerConfigured: Bool = false
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

  @Published var lastError: String? = nil
  @Published var consecutiveFailures: Int = 0
  // Throttle for the auto-restart-on-3-consecutive-fails recovery path.
  // Without this we'd respawn in a tight loop if the daemon is broken
  // for a real reason (port conflict, missing entitlement, etc).
  private var lastAutoRestartAt: Date = .distantPast

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
      let h: HealthResponse = try await get("/health")
      status = computeStatus(h)
      providerName = h.status?.agentHost?.provider ?? "—"
      providerConfigured = h.status?.agentHost?.providerConfigured ?? false
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
      if !didInitialBriefRefresh {
        didInitialBriefRefresh = true
        scheduleBriefRefresh()
      }
      if h.firstRun == true && !offeredSetupThisLaunch {
        offeredSetupThisLaunch = true
        notify(title: "Welcome to OpenAGI", body: "Two minutes of setup and your agent is live.", path: "/setup")
        openDashboard(path: "/setup")
      } else if h.firstRun != true && !providerConfigured && !offeredSetupThisLaunch {
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
      if consecutiveFailures == 3 {
        notify(title: "OpenAGI offline", body: lastError ?? "Daemon stopped responding.", path: "/")
      }
      // Auto-recover: if /health has been failing for 3+ consecutive
      // polls (~15s with default 5s polling), the daemon is genuinely
      // dead. Restart it. Capped at one auto-restart per minute so we
      // don't spin if the daemon is fundamentally broken — the user
      // sees the offline state and can take action.
      if consecutiveFailures == 3, Date().timeIntervalSince(lastAutoRestartAt) > 60 {
        lastAutoRestartAt = Date()
        NSLog("OpenAGI: daemon /health failing — auto-restarting")
        DaemonController.shared.restart()
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
      // Agent queued something that needs approval (gated tool). Land in
      // chat with the action id so the inline approval card renders.
      let summary = parseField(data, "summary") ?? "Agent action awaiting approval"
      let actionId = parseField(data, "id") ?? ""
      let pathPart = actionId.isEmpty ? "/?tab=chat" : "/?tab=chat&pending=\(urlEncode(actionId))"
      notify(title: "🤖 Agent wants to: \(summary)", body: "Tap to approve or deny.", path: pathPart)
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

  struct MessageReply: Decodable { let reply: String? }

  // Send a question to the agent from the floating widget, attaching fresh
  // focused-window context. Returns the agent's reply text.
  func askOverlay(text: String, screenContext: ScreenContext?) async throws -> String {
    var meta: [String: Any] = [:]
    if let s = screenContext, !s.text.isEmpty {
      var sc: [String: Any] = ["app": s.app, "text": s.text]
      if let w = s.window { sc["window"] = w }
      meta["screenContext"] = sc
    }
    let payload: [String: Any] = ["text": text, "channel": "overlay", "metadata": meta]
    let body = try JSONSerialization.data(withJSONObject: payload)
    let data = try await post("/message", body: body)
    let decoded = try JSONDecoder().decode(MessageReply.self, from: data)
    return decoded.reply ?? "(no reply)"
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

  private func get<T: Decodable>(_ path: String) async throws -> T {
    var req = URLRequest(url: Self.buildURL(base: baseURL, path: path))
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
