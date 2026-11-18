import Foundation

struct SyncedSupervisorMessage: Identifiable, Decodable, Equatable, Sendable {
  let id: String
  let role: String
  let text: String
  let at: String?
  let sourceName: String?
  let sourceNodeId: String?
}

struct MacTaskItem: Identifiable, Decodable, Equatable, Sendable {
  let id: String
  let title: String
  let status: String
  let priority: Int?
  let dueAt: String?
  let notes: String?
}

private struct SyncedHistoryResponse: Decodable {
  let messages: [SyncedSupervisorMessage]
}

private struct TasksListResponse: Decodable {
  let tasks: [MacTaskItem]
}

/// Keeps Mac Supervisor Quick Ask, Supervisor Workspace Window, Paseo, iPhone,
/// and Even G2 synced via `devices:supervisor:main` + `/tasks`.
@MainActor
final class SharedSupervisorClient: ObservableObject {
  static let shared = SharedSupervisorClient()

  @Published private(set) var messages: [SyncedSupervisorMessage] = []
  @Published private(set) var tasks: [MacTaskItem] = []
  @Published private(set) var isSending = false
  @Published private(set) var lastError: String? = nil

  private init() {}

  func refreshAll() async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.refreshMessages() }
      group.addTask { await self.refreshTasks() }
    }
  }

  func refreshMessages() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/conversations/supervisor/messages?limit=50"))
    authed(&req)
    req.timeoutInterval = 8
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(SyncedHistoryResponse.self, from: data)
      messages = decoded.messages
      lastError = nil
    } catch {
      // Keep cached transcript cleanly when daemon is restarting.
    }
  }

  func refreshTasks() async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/tasks?queue=user"))
    authed(&req)
    req.timeoutInterval = 8
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      let decoded = try JSONDecoder().decode(TasksListResponse.self, from: data)
      tasks = decoded.tasks.filter { $0.status != "done" && $0.status != "completed" }
    } catch {
      // Non-fatal while daemon starts up.
    }
  }

  func sendMessage(_ text: String, focusedCardId: String? = nil) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !isSending else { return }
    isSending = true
    lastError = nil
    defer { isSending = false }

    let optimistic = SyncedSupervisorMessage(
      id: "local_\(UUID().uuidString)",
      role: "user",
      text: trimmed,
      at: ISO8601DateFormatter().string(from: Date()),
      sourceName: "Mac",
      sourceNodeId: nil
    )
    messages.append(optimistic)

    var payload: [String: Any] = [
      "text": trimmed,
      "thread": "supervisor",
      "metadata": ["sourceName": "Mac"]
    ]
    if let focusedCardId, !focusedCardId.isEmpty {
      payload["focusedCardId"] = focusedCardId
    }
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/message"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    req.timeoutInterval = 180
    authed(&req)

    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(response, data)
      await refreshMessages()
      await refreshTasks()
    } catch {
      lastError = error.localizedDescription
    }
  }

  func appendMirror(userText: String, assistantText: String) async {
    let u = userText.trimmingCharacters(in: .whitespacesAndNewlines)
    let a = assistantText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !u.isEmpty || !a.isEmpty else { return }
    var batch: [[String: Any]] = []
    if !u.isEmpty {
      batch.append(["id": "mac_\(UUID().uuidString)", "role": "user", "text": u])
    }
    if !a.isEmpty {
      batch.append(["id": "mac_\(UUID().uuidString)", "role": "assistant", "text": a])
    }
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/conversations/supervisor/append"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
      "sourceName": "Mac",
      "messages": batch
    ])
    req.timeoutInterval = 8
    authed(&req)
    _ = try? await URLSession.shared.data(for: req)
    await refreshMessages()
  }

  func createTask(title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: "/tasks"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
      "title": trimmed,
      "queue": "user",
      "source": "supervisor"
    ])
    authed(&req)
    _ = try? await URLSession.shared.data(for: req)
    await refreshTasks()
  }

  func completeTask(_ id: String) async {
    var req = URLRequest(url: AppState.buildURL(
      base: AppState.shared.baseURL,
      path: "/tasks/\(id)/complete"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    authed(&req)
    _ = try? await URLSession.shared.data(for: req)
    await refreshTasks()
  }

  private func authed(_ req: inout URLRequest) {
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
  }
}
