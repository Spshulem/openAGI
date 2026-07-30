import Foundation

// Fetches GET /brief/today from the LOCAL daemon and dispatches an item's
// declarative actions back to it.
//
// Refresh model (pinned deliberately — three different precedents exist in
// this codebase): fetch on panel expand and on the SSE events that can change
// the brief. No timer. After a successful action the row is removed
// optimistically and a single refetch reconciles; on failure the row is
// restored and the server's message is surfaced.
@MainActor
final class BriefConsumer: ObservableObject {
  static let shared = BriefConsumer()

  @Published private(set) var items: [BriefItem] = []
  @Published private(set) var olderCount: Int = 0
  @Published private(set) var isLoading = false
  @Published private(set) var lastError: String? = nil
  /// The last action's server-reported outcome ("Task added", "Skill created: …").
  /// Kept SEPARATE from `lastError` on purpose: `act()` refetches immediately and
  /// `refresh()` nils `lastError` on success, so an outcome parked there would be
  /// wiped before it ever rendered. Nothing clears this but the next action.
  @Published private(set) var lastOutcome: String? = nil
  /// Action ids currently in flight, keyed by item id. `accept` is NOT
  /// idempotent server-side (skill materialization dedupes into slug-2,
  /// slug-3), so a double tap must be impossible.
  @Published private(set) var inFlight: Set<String> = []

  /// True when BriefSection would render anything at all. The overlay gates the
  /// whole section on this rather than on `items`, so an outcome, an error, or
  /// the "N older" count still shows once the last row has been acted on.
  var hasContent: Bool {
    !items.isEmpty || isLoading || olderCount > 0 || lastError != nil || lastOutcome != nil
  }

  private var baseURL: URL { AppState.shared.baseURL }
  private func token() -> String? { AppState.shared.authToken() }

  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      var req = URLRequest(url: AppState.buildURL(base: baseURL, path: "/brief/today?limit=5"))
      req.timeoutInterval = 6
      if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
      let (data, resp) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(resp, data)
      let decoded = try JSONDecoder().decode(BriefResponse.self, from: data)
      items = decoded.items
      olderCount = decoded.older.count
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func act(_ item: BriefItem, _ action: BriefAction) async {
    guard !inFlight.contains(item.id) else { return }
    inFlight.insert(item.id)
    defer { inFlight.remove(item.id) }

    let snapshot = items
    lastOutcome = nil                      // the previous action's result is stale now
    items.removeAll { $0.id == item.id }   // optimistic

    do {
      var req = URLRequest(url: AppState.buildURL(base: baseURL, path: action.path))
      req.httpMethod = action.method
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.timeoutInterval = 10
      if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
      if let body = action.body {
        req.httpBody = try JSONSerialization.data(withJSONObject: body.mapValues { $0.value })
      } else if action.method != "DELETE" {
        req.httpBody = "{}".data(using: .utf8)
      }
      let (data, resp) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(resp, data)
      lastOutcome = outcomeMessage(data)
      await refresh()
    } catch {
      items = snapshot            // restore — the decision was not recorded
      lastError = error.localizedDescription
    }
  }

  /// POST /proactive/suggestions/:id/accept returns POLYMORPHIC 200s: success
  /// shapes carry taskId / registered / skillSlug, but FAILURES also come back
  /// as 200 with a *Error field. Reporting a flat "Accepted" would lie, so
  /// read the body and say what actually happened.
  private func outcomeMessage(_ data: Data) -> String? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    for key in ["taskCreateError", "skillCreateError", "registerError", "error"] {
      if let msg = obj[key] as? String, !msg.isEmpty { return "Failed: \(msg)" }
    }
    if obj["taskId"] is String { return "Task added" }
    if let mcp = obj["registered"] as? String { return "Connected \(mcp)" }
    if let slug = obj["skillSlug"] as? String { return "Skill created: \(slug)" }
    return nil
  }
}
