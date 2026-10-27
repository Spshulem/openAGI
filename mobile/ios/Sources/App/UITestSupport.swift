#if DEBUG
import Foundation
import SwiftUI
import os

// UI tests exercise the real screens and transport decoder with synthetic
// responses. The test model uses a synthetic credential and an isolated store;
// its transport intercepts every request instead of contacting a real daemon.
@MainActor
struct UITestRoot: View {
    @State private var model = UITestProtocol.makeModel()

    var body: some View {
        Group {
            if ProcessInfo.processInfo.arguments.contains("--ui-guided-setup") {
                WelcomeView(availability: .unsupported, prefersChat: true)
            } else { RootTabView(testingModel: model) }
        }
        .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("--ui-dark") ? .dark : nil)
    }
}

final class UITestProtocol: URLProtocol, @unchecked Sendable {
    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--ui-testing") || StoreScreenshotProtocol.isEnabled
    }
    private static let preference = OSAllocatedUnfairLock(initialState: "auto")
    private static let integrationKeySaved = OSAllocatedUnfairLock(initialState: false)
    private struct ChatLine: Sendable {
        let id: String
        let role: String
        let text: String
        let at: String
        let attachments: [[String: String]]
        var json: [String: Any] {
            var result: [String: Any] = ["id": id, "role": role, "text": text, "at": at]
            if !attachments.isEmpty { result["attachments"] = attachments }
            return result
        }
    }
    private static let chats = OSAllocatedUnfairLock(initialState: [String: [ChatLine]]())
    private static let namedChats = OSAllocatedUnfairLock(initialState: [String: String]())
    private static let modelFailures = OSAllocatedUnfairLock(initialState: ProcessInfo.processInfo.arguments.contains("--ui-model-first-fails") ? 1 : 0)
    private static let date = "2026-10-18T12:00:00.000Z"

    @MainActor
    static func makeModel() -> AppModel {
        if StoreScreenshotProtocol.isEnabled { return StoreScreenshotProtocol.makeModel() }
        let directory = FileManager.default.temporaryDirectory.appending(path: "ui-test-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let credentials = Credentials(server: URL(string: "https://daemon.example.com")!,
                                      nodeID: "mobile:ui-fixture", token: "synthetic-ui-fixture")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UITestProtocol.self]
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID,
                                  token: credentials.token, session: URLSession(configuration: configuration))
        return AppModel(credentials: credentials, client: client,
                        store: SnapshotStore(directory: directory), queue: OutboundQueue(directory: directory),
                        chatDirectory: directory)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        if ProcessInfo.processInfo.arguments.contains("--ui-unauthorized") {
            finish(status: 401, object: ["error": "unauthorized"])
            return
        }
        if url.path == "/message" {
            guard let data = Self.body(request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                finish(status: 400, object: ["error": "missing message body"])
                return
            }
            let thread = body["thread"] as? String ?? "agent"
            let conversationID = body["conversationId"] as? String ?? "main"
            let key = conversationID == "main" ? thread : "\(thread):\(conversationID)"
            let images = body["attachments"] as? [[String: String]] ?? []
            if images.contains(where: { image in
                guard image["mimeType"] == "image/jpeg", let encoded = image["data"],
                      let data = Data(base64Encoded: encoded) else { return true }
                return !data.starts(with: [255, 216, 255])
            }) {
                finish(status: 400, object: ["error": "Image pixels must reach the transport"])
                return
            }
            let reply = images.isEmpty ? "Synthetic reply" : "Synthetic image received in \(thread)"
            let at = ISO8601DateFormatter().string(from: Date())
            let previews = images.map { $0.filter { $0.key != "data" } }
            let text = body["text"] as? String ?? ""
            Self.chats.withLock { chats in
                chats[key, default: []].append(ChatLine(id: UUID().uuidString, role: "user", text: text, at: at, attachments: previews))
                chats[key, default: []].append(ChatLine(id: UUID().uuidString, role: "assistant", text: reply, at: at, attachments: []))
            }
            let delta = String(data: try! JSONSerialization.data(withJSONObject: ["text": reply, "reset": false]), encoding: .utf8)!
            let final = String(data: try! JSONSerialization.data(withJSONObject: ["reply": reply]), encoding: .utf8)!
            let stream = "event: delta\ndata: \(delta)\n\nevent: final\ndata: \(final)\n\n"
            deliver(status: 200, data: Data(stream.utf8), contentType: "text/event-stream")
            return
        }
        let empty = ProcessInfo.processInfo.arguments.contains("--ui-empty-today")
        let tasks = [Self.task(id: "demo-one", title: "Plan a synthetic demo"),
                     Self.task(id: "demo-two", title: "Review a synthetic demo")]
        switch url.path {
        case "/conversations":
            if request.httpMethod == "POST" {
                guard let body = Self.body(request), let payload = try? JSONSerialization.jsonObject(with: body) as? [String: String],
                      let thread = payload["thread"], ["agent", "supervisor"].contains(thread) else {
                    finish(status: 400, object: ["error": "invalid conversation"])
                    return
                }
                let id = UUID().uuidString.lowercased()
                Self.namedChats.withLock { $0[id] = thread }
                finish(status: 201, object: Self.summary(id: id, thread: thread))
            } else {
                let defaults = ["agent", "supervisor"].map { Self.summary(id: "main", thread: $0) }
                let named = Self.namedChats.withLock { $0 }.map { Self.summary(id: $0.key, thread: $0.value) }
                let web: [String: Any] = ["id": "web-" + String(repeating: "a", count: 32), "thread": "agent", "title": "A synthetic web conversation", "preview": "Earlier work on the web", "updatedAt": Self.date, "messageCount": 2, "readOnly": true]
                finish(object: ["conversations": defaults + named + [web]])
            }
        case "/mobile/summary":
            finish(object: ["generatedAt": Self.date, "today": empty ? [] : tasks.map { $0.merging(["overdue": false]) { _, new in new } },
                            "counts": ["today": empty ? 0 : 2, "this_week": 0, "overdue": 0, "pendingActions": 2],
                            "pendingActions": [], "brief": ["headline": empty ? "" : "Two tasks for your demo"]])
        case "/tasks":
            let queue = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "queue" }?.value
            finish(object: ["tasks": queue == "agent" ? [Self.task(id: "demo-agent", title: "Prepare a synthetic report", queue: "agent")] : tasks])
        case "/tasks/demo-one", "/tasks/demo-two":
            finish(object: tasks.first { $0["id"] as? String == url.lastPathComponent } ?? tasks[0])
        case "/pending-actions":
            finish(object: ["actions": [Self.action(id: "approval-one", title: "Approve the first synthetic action"),
                                        Self.action(id: "approval-two", title: "Approve the second synthetic action")]])
        case "/tasks/clarifications":
            finish(object: [["id": "question-one", "taskId": "demo-one", "question": "Is the synthetic demo ready?",
                             "context": "A synthetic UI test", "proposedAction": "Confirm the demo", "sources": [],
                             "status": "pending", "createdAt": Self.date]])
        case "/settings/models":
            let shouldFail = Self.modelFailures.withLock { remaining -> Bool in
                guard remaining > 0 else { return false }
                remaining -= 1
                return true
            }
            if shouldFail {
                finish(status: 404, object: ["error": "not found"])
                return
            }
            if request.httpMethod == "POST", let body = Self.body(request),
               let payload = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let selected = payload["preference"] as? String {
                Self.preference.withLock { $0 = selected }
            }
            finish(object: ["preference": Self.preference.withLock { $0 },
                            "active": ["provider": Self.preference.withLock { $0 == "openai" ? "openai" : "anthropic" }, "model": "demo-model"],
                            "providers": ["anthropic": ["configured": true, "model": "demo-model"],
                                          "openai": ["configured": true, "model": "demo-model"],
                                          "chatgpt": ["signedIn": false]]])
        case "/settings/models/test":
            finish(object: ["ok": true, "model": "demo-model"])
        case "/workspace/persona":
            finish(object: ["markdown": "Synthetic instructions for the UI test."])
        case "/workspace/skills": finish(object: ["skills": []])
        case "/workspace/jobs": finish(object: ["jobs": []])
        case "/workspace/integrations", "/workspace/integrations/linear":
            if request.httpMethod == "PUT" { Self.integrationKeySaved.withLock { $0 = true } }
            if request.httpMethod == "DELETE" { Self.integrationKeySaved.withLock { $0 = false } }
            let saved = Self.integrationKeySaved.withLock { $0 }
            finish(object: ["integrations": [["id": "linear", "name": "Linear", "available": true,
                                               "configured": saved, "apiKeySaved": saved]]])
        case "/workspace/integrations/linear/sync":
            finish(object: ["ok": true, "created": 1, "updated": 0, "completed": 0])
        case "/fleet/api/state":
            finish(object: ["mode": "observe", "enabled": false, "running": false,
                            "snapshot": ["at": Self.date, "threads": [["key": "codex:fixture", "title": "Synthetic review thread", "workspace": "Demo workspace", "state": "needs-human"]]],
                            "questions": [["id": "context-fixture", "title": "Review the synthetic request", "body": "Read the recent activity before choosing a response.", "kind": "agent-ask", "threadKey": "codex:fixture", "options": ["yes", "no", "open thread"], "createdAt": Self.date]]])
        case "/fleet/api/threads/codex:fixture":
            finish(object: ["thread": ["key": "codex:fixture", "scannedAt": Self.date,
                                       "lastOwnerMessage": ["text": "Explain the synthetic change before I decide.", "at": Self.date],
                                       "lastAgentMessage": ["text": "The synthetic change is ready for your review. Nothing has been sent.", "at": Self.date],
                                       "conversation": ["messages": [
                                        ["id": "context-owner", "role": "user", "text": "Show the earlier synthetic request.", "at": Self.date],
                                        ["id": "context-agent", "role": "assistant", "text": "Here is the earlier synthetic explanation.", "at": Self.date]
                                       ], "truncated": false]]])
        case let path where path.hasPrefix("/fleet/api/questions/"):
            // Opening context is a read, never a submission of 'open thread'.
            finish(status: 500, object: ["error": "Opening context must not submit an answer"])
        case let path where path.hasPrefix("/conversations/"):
            let thread = path.contains("/supervisor/") ? "supervisor" : "agent"
            let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "conversationId" }?.value ?? "main"
            let key = id == "main" ? thread : "\(thread):\(id)"
            let sent = Self.chats.withLock { $0[key, default: []] }.map(\.json)
            if id != "main" && !id.hasPrefix("web-") {
                finish(object: ["thread": thread, "messages": sent])
                return
            }
            if ProcessInfo.processInfo.arguments.contains("--ui-scroll-chat") {
                let rows: [[String: Any]] = (0..<50).map { index in
                    ["id": "scroll-\(index)", "role": index % 2 == 0 ? "user" : "assistant",
                     "text": index == 49 ? "Latest synthetic message" : "History item \(index). " + Self.longBullet,
                     "at": Self.date]
                }
                finish(object: ["thread": thread, "messages": rows + sent])
                return
            }
            if ProcessInfo.processInfo.arguments.contains("--ui-long-chat") {
                finish(object: ["thread": "agent", "messages": [
                    ["id": "history-one", "role": "user", "text": "yes", "at": Self.date],
                    ["id": "history-two", "role": "assistant", "text": "## Synthetic review\n\n- " + Self.longBullet + "\n\nThe final synthetic paragraph remains readable.", "at": Self.date]
                ]])
                return
            }
            finish(object: ["thread": "agent", "messages": [
                ["id": "history-one", "role": "user", "text": "Earlier synthetic question", "at": Self.date],
                ["id": "history-two", "role": "assistant", "text": "Earlier synthetic answer", "at": Self.date]
            ] + sent])
        default: finish(object: [:])
        }
    }

    static let longBullet = "This synthetic list item explains the context of a decision in enough detail to wrap naturally across several lines on a phone, including a cover display or one page of a book layout. The entire explanation must remain readable before anyone makes a decision."

    private static func summary(id: String, thread: String) -> [String: Any] {
        let key = id == "main" ? thread : "\(thread):\(id)"
        let lines = chats.withLock { $0[key, default: []] }
        return ["id": id, "thread": thread, "title": lines.first?.text ?? (id == "main" ? "Shared \(thread) chat" : "New chat"),
                "preview": lines.last?.text ?? "Start a conversation", "updatedAt": lines.last?.at ?? date,
                "messageCount": lines.count, "readOnly": false]
    }

    private static func task(id: String, title: String, queue: String = "user") -> [String: Any] {
        ["id": id, "queue": queue, "title": title, "description": "Synthetic UI test task", "bucket": "today",
         "priority": 50, "tags": [], "source": "manual", "status": "pending", "dependsOn": [],
         "createdAt": date, "updatedAt": date]
    }

    private static func action(id: String, title: String) -> [String: Any] {
        ["id": id, "toolName": "synthetic_demo", "summary": title, "status": "pending", "createdAt": date]
    }

    private static func body(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            body.append(buffer, count: count)
        }
        return body
    }

    private func finish(status: Int = 200, object: Any) {
        do { deliver(status: status, data: try JSONSerialization.data(withJSONObject: object), contentType: "application/json") }
        catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    private func deliver(status: Int, data: Data, contentType: String) {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                                                 headerFields: ["Content-Type": contentType]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
#endif
