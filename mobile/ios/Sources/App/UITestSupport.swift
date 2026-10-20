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
        RootTabView(testingModel: model)
            .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("--ui-dark") ? .dark : nil)
    }
}

final class UITestProtocol: URLProtocol, @unchecked Sendable {
    static var isEnabled: Bool { ProcessInfo.processInfo.arguments.contains("--ui-testing") }
    private static let preference = OSAllocatedUnfairLock(initialState: "auto")
    private static let integrationKeySaved = OSAllocatedUnfairLock(initialState: false)
    private static let date = "2026-10-18T12:00:00.000Z"

    @MainActor
    static func makeModel() -> AppModel {
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
            let stream = "event: delta\ndata: {\"text\":\"Synthetic reply\",\"reset\":false}\n\nevent: final\ndata: {\"reply\":\"Synthetic reply\"}\n\n"
            deliver(status: 200, data: Data(stream.utf8), contentType: "text/event-stream")
            return
        }
        let empty = ProcessInfo.processInfo.arguments.contains("--ui-empty-today")
        let tasks = [Self.task(id: "demo-one", title: "Plan a synthetic demo"),
                     Self.task(id: "demo-two", title: "Review a synthetic demo")]
        switch url.path {
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
        case let path where path.hasPrefix("/conversations/"):
            finish(object: ["thread": "agent", "messages": [
                ["id": "history-one", "role": "user", "text": "Earlier synthetic question", "at": Self.date],
                ["id": "history-two", "role": "assistant", "text": "Earlier synthetic answer", "at": Self.date]
            ]])
        default: finish(object: [:])
        }
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
