import Foundation

/// The local daemon's durable human-approval queue.
///
/// Approvals used to reach the Mac only as a notification/outreach event. That
/// made the notification the sole reliable button: a newer suggestion could
/// push the approval below Quick Ask's six-row limit, and restarting the app
/// advanced the outreach cursor without rebuilding unresolved items. This
/// consumer always reconciles against `/pending-actions`, so the floating UI is
/// an authoritative approval surface rather than a transient event viewer.
struct PendingApproval: Identifiable, Decodable, Equatable {
  let id: String
  let toolName: String
  let summary: String
  let status: String
  let createdAt: String?

  enum CodingKeys: String, CodingKey {
    case id, toolName, summary, status, createdAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    toolName = try c.decodeIfPresent(String.self, forKey: .toolName) ?? "agent_action"
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? "Agent action needs approval"
    status = try c.decodeIfPresent(String.self, forKey: .status) ?? "pending"
    createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
  }
}

private struct PendingApprovalsResponse: Decodable {
  let actions: [PendingApproval]
}

@MainActor
final class PendingApprovalConsumer: ObservableObject {
  static let shared = PendingApprovalConsumer()

  @Published private(set) var items: [PendingApproval] = []
  @Published private(set) var inFlight: Set<String> = []
  @Published private(set) var lastOutcome: String? = nil
  @Published private(set) var lastError: String? = nil

  func refresh() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/pending-actions?status=pending"))
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        throw URLError(.badServerResponse)
      }
      let decoded = try JSONDecoder().decode(PendingApprovalsResponse.self, from: data)
      items = decoded.actions.filter { $0.status == "pending" }
      lastError = nil
    } catch {
      lastError = "Couldn't refresh approvals."
    }
  }

  func approve(_ id: String) async { await decide(id, decision: "approve") }
  func deny(_ id: String) async { await decide(id, decision: "deny") }

  private func decide(_ id: String, decision: String) async {
    guard !inFlight.contains(id) else { return }
    inFlight.insert(id)
    defer { inFlight.remove(id) }

    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/pending-actions/\(id)/\(decision)"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    authed(&req)
    do {
      let (_, response) = try await URLSession.shared.data(for: req)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        throw URLError(.badServerResponse)
      }
      items.removeAll { $0.id == id }
      lastOutcome = decision == "approve"
        ? "Approved — the agent is continuing in Chat."
        : "Request denied."
      lastError = nil
      await refresh()
    } catch {
      lastError = decision == "approve" ? "Approval failed. Try again." : "Couldn't deny the request."
    }
  }

  func clearOutcome() { lastOutcome = nil }

  private func authed(_ req: inout URLRequest) {
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
  }
}
