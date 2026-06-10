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
  @Published var nudges: [Nudge] = []

  struct Nudge: Identifiable, Equatable {
    let id: String
    let title: String
    let body: String
    let category: String
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

  func handleSSEEvent(_ event: String, _ data: String) {
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
      let title = "\(prefix): \(parsed.name ?? "OpenAGI noticed something")"
      let body = parseField(data, "rationale") ?? parsed.description ?? "Tap to review in chat."
      let suggestionId = parseField(data, "id") ?? ""
      let pathPart = suggestionId.isEmpty ? "/?tab=chat" : "/?tab=chat&suggestion=\(urlEncode(suggestionId))"
      notify(title: title, body: body, path: pathPart)
      let nudge = Nudge(
        id: suggestionId.isEmpty ? UUID().uuidString : suggestionId,
        title: parsed.name ?? "OpenAGI noticed something",
        body: body,
        category: category
      )
      nudges.removeAll { $0.id == nudge.id }
      nudges.insert(nudge, at: 0)
      if nudges.count > 20 { nudges = Array(nudges.prefix(20)) }
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

  private func get<T: Decodable>(_ path: String) async throws -> T {
    var req = URLRequest(url: baseURL.appendingPathComponent(path))
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (data, _) = try await URLSession.shared.data(for: req)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func post(_ path: String, body: Data? = nil) async throws -> Data {
    var req = URLRequest(url: baseURL.appendingPathComponent(path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body = body { req.httpBody = body }
    let (data, _) = try await URLSession.shared.data(for: req)
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
