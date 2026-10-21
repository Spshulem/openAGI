#if DEBUG
import Foundation

// Fictional content for captures of the real native views. Every request is
// intercepted, so this mode cannot read a person's tasks, keys or chat history.
// Screenshot fixtures demonstrate UI only; they do not test local inference.
final class StoreScreenshotProtocol: URLProtocol, @unchecked Sendable {
    static var isEnabled: Bool { ProcessInfo.processInfo.arguments.contains("--store-screenshots") }
    private static let date = ISO8601DateFormatter().string(from: Date())

    @MainActor static func makeModel() -> AppModel {
        // Match a running embedded origin for HostAllowlist. This process's
        // fixture session still intercepts every request; no socket is opened.
        EmbeddedLoopback.port = 19999
        let directory = FileManager.default.temporaryDirectory.appending(path: "store-capture-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let credentials = Credentials(server: URL(string: "http://127.0.0.1:19999")!,
                                      nodeID: "mobile:store-fixture", token: "fictional-store-fixture")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StoreScreenshotProtocol.self]
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
        let today = [Self.task("outline", "Outline the new project", priority: 80),
                     Self.task("notes", "Review yesterday's notes", priority: 60),
                     Self.task("walk", "Take a walk outside", priority: 40)]
        let question: [String: Any] = [
            "id": "outline-time", "taskId": "outline",
            "question": "How much time would you like for the project outline?",
            "context": "Your morning plan", "proposedAction": "Set aside 30 minutes",
            "sources": [], "status": "pending", "createdAt": Self.date
        ]
        let object: Any
        switch url.path {
        case "/mobile/summary":
            object = ["generatedAt": Self.date,
                      "today": today.map { $0.merging(["overdue": false]) { _, new in new } },
                      "counts": ["today": 3, "this_week": 1, "overdue": 0, "pendingActions": 0],
                      "pendingActions": [], "brief": ["headline": "A little focus. A little fresh air."]]
        case "/tasks":
            let queue = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "queue" }?.value
            object = ["tasks": queue == "agent" ? [] : today + [Self.task("reading", "Make time for a new book", bucket: "this_week")]]
        case "/tasks/clarifications": object = [question]
        case "/pending-actions": object = ["actions": []]
        case "/settings/models":
            object = ["preference": "on-device", "active": ["provider": "on-device", "model": "Apple Intelligence"],
                      "providers": ["anthropic": ["configured": false], "openai": ["configured": false],
                                    "chatgpt": ["signedIn": false]]]
        case "/workspace/persona":
            object = ["markdown": "# My agent\n\nHelp me make thoughtful plans and keep track of what matters.\nKeep answers clear and ask when you need my input."]
        case "/workspace/skills": object = ["skills": []]
        case "/workspace/jobs": object = ["jobs": []]
        case "/workspace/integrations": object = ["integrations": []]
        case let path where path.hasPrefix("/conversations/"):
            object = ["thread": "agent", "messages": [
                ["id": "morning-question", "role": "user", "at": Self.date,
                 "text": "Help me plan my morning. I need to outline a project, review my notes, and get outside."],
                ["id": "morning-plan", "role": "assistant", "at": Self.date,
                 "text": "Let's keep it simple:\n\n1. Outline the new project.\n2. Review yesterday's notes.\n3. Take a walk outside.\n\nI've added all three to Today. How much time would you like for the outline?"]
            ]]
        default: object = [:]
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    private static func task(_ id: String, _ title: String, bucket: String = "today", priority: Int = 50) -> [String: Any] {
        ["id": id, "queue": "user", "title": title, "description": "", "bucket": bucket,
         "priority": priority, "tags": [], "source": "manual", "status": "pending", "dependsOn": [],
         "createdAt": date, "updatedAt": date]
    }
}
#endif
