import Foundation

/// The coding-agent supervisor's open questions, from the LOCAL daemon's
/// /fleet/api/* routes (the same JSON the /fleet page uses).
///
/// Fails soft: a daemon without a supervisor (404/503), or one that is off
/// with nothing open, just hides the Supervisor tab. Nothing here is
/// optimistic — an answer can take minutes to reach the agent (typing into an
/// app), and the question stays on screen, in flight, until the daemon says
/// what happened.
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
    guard !inFlight.contains(id) else { return }
    inFlight.insert(id)
    defer { inFlight.remove(id) }
    clearOutcome()

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
        if result.isError { setActionError(result.text) } else { lastOutcome = result.text }
      case 400, 404, 409, 500:
        setActionError(Self.serverError(data) ?? "The supervisor couldn't take that answer.")
        await refresh()
      case 503:
        setActionError("Supervisor isn't available.")
      case 401:
        setActionError("Daemon sign-in failed.")
      default:
        setActionError("Couldn't reach the supervisor. Try again.")
      }
    } catch let error as URLError where error.code == .timedOut {
      setActionError("No reply yet. It may still be sending.")
      await refresh()
    } catch {
      setActionError("Couldn't reach the supervisor. Try again.")
    }
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
        if let state = (try? JSONDecoder().decode(FleetErrorBody.self, from: data))?.state { apply(state) }
        setActionError("Scan failed.")
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
    questions = state.questions
    status = state.status
    setAvailable(state.enabled || !state.questions.isEmpty)
    OverlayState.shared.pruneFleetContext(openIDs: Set(state.questions.map(\.id)))
  }

  private func clearState() {
    generation &+= 1
    questions = []
    status = nil
    setAvailable(false)
    OverlayState.shared.pruneFleetContext(openIDs: [])
  }

  private func setAvailable(_ value: Bool) {
    available = value
    // No supervisor, no tab: never leave the panel on an empty one.
    if !value { OverlayState.shared.selectTab(.tasks) }
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

  /// One line under the Supervisor header: "Scanned 4m ago · 3 need you · Propose".
  static func statusLine(_ status: FleetStatus, count: Int, now: Date = Date()) -> String {
    var parts: [String] = []
    if let at = status.lastTickAt.flatMap(parseDate) {
      parts.append("Scanned \(relative(at, now: now))")
    } else {
      parts.append("Not scanned yet")
    }
    parts.append(count == 0 ? "nothing needs you" : count == 1 ? "1 needs you" : "\(count) need you")
    if !status.mode.isEmpty { parts.append(status.mode.prefix(1).uppercased() + status.mode.dropFirst()) }
    if !status.enabled { parts.append("auto-scan off") }
    return parts.joined(separator: " · ")
  }

  private static func relative(_ date: Date, now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return "just now" }
    if seconds < 3_600 { return "\(seconds / 60)m ago" }
    if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
    return "\(seconds / 86_400)d ago"
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
