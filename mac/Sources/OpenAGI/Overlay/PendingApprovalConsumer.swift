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
  let sourceSessionId: String?

  private struct Context: Decodable {
    let sessionId: String?
  }

  enum CodingKeys: String, CodingKey {
    case id, toolName, summary, status, createdAt, context
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    toolName = try c.decodeIfPresent(String.self, forKey: .toolName) ?? "agent_action"
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? "Agent action needs approval"
    status = try c.decodeIfPresent(String.self, forKey: .status) ?? "pending"
    createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    sourceSessionId = try c.decodeIfPresent(Context.self, forKey: .context)?.sessionId
  }
}

private struct PendingApprovalsResponse: Decodable {
  let actions: [PendingApproval]
}

private struct PendingApprovalDecisionResponse: Decodable {
  let error: String?
  let result: PendingApprovalExecutionResult?
}

private struct PendingApprovalExecutionResult: Decodable {
  let sessionId: String?
}

@MainActor
final class PendingApprovalConsumer: ObservableObject {
  static let shared = PendingApprovalConsumer()

  @Published private(set) var items: [PendingApproval] = []
  @Published private(set) var inFlight: Set<String> = []
  @Published private(set) var lastOutcome: String? = nil
  @Published private(set) var lastError: String? = nil
  @Published private(set) var lastChatSessionId: String? = nil

  /// Only the newest reconciliation may publish. Refreshes arrive from panel
  /// appearance, SSE, and decisions, so response order is not request order.
  private var refreshGeneration: UInt64 = 0
  private var activeComputerSessionId: String? = nil

  func refresh() async {
    refreshGeneration &+= 1
    let generation = refreshGeneration
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
      guard generation == refreshGeneration else { return }
      items = decoded.actions.filter { $0.status == "pending" }
      lastError = nil
    } catch {
      guard generation == refreshGeneration else { return }
      lastError = "Couldn't refresh approvals."
    }
  }

  func approve(_ id: String) async { await decide(id, decision: "approve") }
  func deny(_ id: String) async { await decide(id, decision: "deny") }

  private func decide(_ id: String, decision: String) async {
    guard !inFlight.contains(id) else { return }
    inFlight.insert(id)
    defer { inFlight.remove(id) }
    let approval = items.first(where: { $0.id == id })
    let sourceSessionId = approval?.sourceSessionId
    let isComputerUseApproval = Self.isComputerUseApproval(approval?.toolName)

    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/pending-actions/\(id)/\(decision)"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    authed(&req)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      guard let http = response as? HTTPURLResponse else {
        throw URLError(.badServerResponse)
      }
      if !(200..<300).contains(http.statusCode) {
        if let terminalError = Self.terminalDecisionError(statusCode: http.statusCode, data: data) {
          // 400 means the approved handler ran and failed; 409 means another
          // surface already claimed/decided it. Either way it is no longer a
          // pending action, so never offer a retry that can only fail again.
          items.removeAll { $0.id == id }
          if isComputerUseApproval {
            activeComputerSessionId = nil
            lastChatSessionId = sourceSessionId ?? lastChatSessionId
          }
          await refresh()
          lastOutcome = decision == "approve"
            ? "Approval recorded, but the action did not complete."
            : "The request was already being handled."
          lastError = terminalError
          return
        }
        throw URLError(.badServerResponse)
      }
      items.removeAll { $0.id == id }
      let decoded = try? JSONDecoder().decode(PendingApprovalDecisionResponse.self, from: data)
      if decision == "approve" {
        if isComputerUseApproval {
          activeComputerSessionId = decoded?.result?.sessionId
          lastChatSessionId = sourceSessionId
          lastOutcome = activeComputerSessionId == nil
            ? "Approved — the agent is continuing in Chat."
            : "Approved — the computer task is running in Chat."
        } else {
          lastOutcome = "Approved."
        }
      } else {
        if isComputerUseApproval {
          activeComputerSessionId = nil
          lastChatSessionId = nil
        }
        lastOutcome = "Request denied."
      }
      lastError = nil
      await refresh()
    } catch {
      lastError = decision == "approve" ? "Approval failed. Try again." : "Couldn't deny the request."
    }
  }

  func clearOutcome() {
    lastOutcome = nil
    lastError = nil
    activeComputerSessionId = nil
    lastChatSessionId = nil
  }

  /// Reconcile the transient approval banner with the durable computer-use
  /// session. Approval returns before the resumed agent finishes; a later SSE
  /// session-end event is the authoritative terminal state.
  func handleComputerUseEvent(_ data: String) {
    guard let sessionId = activeComputerSessionId,
          let terminal = Self.terminalComputerUseOutcome(sessionId: sessionId, data: data) else { return }
    activeComputerSessionId = nil
    lastChatSessionId = terminal.chatSessionId ?? lastChatSessionId
    lastOutcome = terminal.outcome
    lastError = terminal.error
  }

  static func terminalComputerUseOutcome(
    sessionId: String,
    data: String
  ) -> (outcome: String?, error: String?, chatSessionId: String?)? {
    guard let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any],
          json["kind"] as? String == "session-end",
          let session = json["session"] as? [String: Any],
          session["id"] as? String == sessionId else { return nil }
    let chatSessionId = session["sourceSessionId"] as? String
    if session["status"] as? String == "ended" {
      return ("Computer task finished.", nil, chatSessionId)
    }
    return (nil, "Computer task stopped.", chatSessionId)
  }

  static func terminalDecisionError(statusCode: Int, data: Data) -> String? {
    guard statusCode == 400 || statusCode == 409 else { return nil }
    let decoded = try? JSONDecoder().decode(PendingApprovalDecisionResponse.self, from: data)
    let message = decoded?.error?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let message, !message.isEmpty { return String(message.prefix(300)) }
    return statusCode == 400
      ? "The approved action failed during execution."
      : "This approval is no longer pending."
  }

  static func isComputerUseApproval(_ toolName: String?) -> Bool {
    toolName == "start_computer_use_session"
  }

  private func authed(_ req: inout URLRequest) {
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
  }
}
