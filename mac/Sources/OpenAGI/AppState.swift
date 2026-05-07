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
  @Published var paused: Bool = false

  private var pollTimer: Timer?
  private var sseTask: URLSessionDataTask?
  private var sseSession: URLSession?

  enum HealthStatus { case unknown, healthy, degraded, down }

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
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let dir = support.appendingPathComponent("OpenAGI", isDirectory: true)
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

  private func pollOnce() async {
    do {
      let h: HealthResponse = try await get("/health")
      status = computeStatus(h)
      providerName = h.status?.agentHost?.provider ?? "—"
      providerConfigured = h.status?.agentHost?.providerConfigured ?? false
      memoryShort = h.status?.memory?.short ?? 0
      memoryMedium = h.status?.memory?.medium ?? 0
      memoryLong = h.status?.memory?.long ?? 0

      let b: BudgetResponse = try await get("/budget")
      spentToday = b.spentUsd ?? 0
      spentLimit = b.dailyUsdLimit ?? 10

      let a: AuditResponse = try await get("/audit")
      findings = a.findings ?? []

      let sessions: [SessionSummary] = try await get("/sessions")
      recentSessions = Array(sessions.prefix(5))

      if status != .healthy { Task { await self.fetchAuditAndNotify() } }
    } catch {
      status = .down
    }
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
  }

  private func fetchAuditAndNotify() async {
    if findings.contains(where: { $0.severity == "warn" && $0.area == "budget" }) {
      notify(title: "OpenAGI budget", body: "Today's spend > 70% of daily cap.", path: "/")
    }
    if findings.contains(where: { $0.area == "specialists" }) {
      // Avoid spamming — only notify on transitions; for now, no-op.
    }
  }

  // MARK: — Actions

  func openDashboard(path: String = "/") {
    let token = authToken() ?? ""
    let url = URL(string: "http://127.0.0.1:43210\(path)?token=\(token)")!
    NSWorkspace.shared.open(url)
  }

  func notify(title: String, body: String, path: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.userInfo = ["path": path]
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req)
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
