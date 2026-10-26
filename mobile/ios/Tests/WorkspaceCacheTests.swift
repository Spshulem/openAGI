import XCTest
import os
@testable import OpenAGI

final class WorkspaceCacheTests: XCTestCase {
    private var directory: URL!
    private let credentials = Credentials(server: URL(string: "https://daemon.example.com")!,
        nodeID: "mobile:workspace-test", token: "synthetic-workspace-token")

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        StubProtocol.failure = nil
        StubProtocol.handler = nil
    }

    override func tearDownWithError() throws {
        StubProtocol.failure = nil
        StubProtocol.handler = nil
        try FileManager.default.removeItem(at: directory)
    }

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: URL(filePath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "fixtures/\(name).json"))
    }

    @MainActor
    private func model() -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID,
            token: credentials.token, session: URLSession(configuration: config))
        return AppModel(credentials: credentials, client: client, store: SnapshotStore(directory: directory),
            queue: OutboundQueue(directory: directory), chatDirectory: directory)
    }

    func testCacheIsolatesServerNodeAndCredentialAndSurvivesCorruption() throws {
        let tasks = try ProtocolDecoder.json.decode(TasksListResponse.self, from: fixture("tasks-list")).tasks
        let snapshot = WorkspaceSnapshot(tasks: ["user": tasks])
        let cache = WorkspaceCache(credentials: credentials, directory: directory)
        try cache.save(snapshot)
        XCTAssertEqual(cache.load(), snapshot)
        let others = [
            Credentials(server: URL(string: "https://other.example.com")!, nodeID: credentials.nodeID, token: credentials.token),
            Credentials(server: credentials.server, nodeID: "mobile:other", token: credentials.token),
            Credentials(server: credentials.server, nodeID: credentials.nodeID, token: "synthetic-other-token")
        ]
        for other in others { XCTAssertTrue(WorkspaceCache(credentials: other, directory: directory).load().tasks.isEmpty) }
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        try Data("corrupt cache".utf8).write(to: file)
        XCTAssertTrue(cache.load().tasks.isEmpty)
        cache.delete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    @MainActor
    func testCachedRowsAppearBeforeNetworkAndFailedRefreshRetainsThem() async throws {
        let rows = try ProtocolDecoder.json.decode(TasksListResponse.self, from: fixture("tasks-list")).tasks
        let actions = try ProtocolDecoder.json.decode(PendingActionsResponse.self, from: fixture("pending-actions")).actions
        try WorkspaceCache(credentials: credentials, directory: directory).save(
            WorkspaceSnapshot(tasks: ["user": rows], pendingActions: actions, clarifications: []))
        let app = model()
        XCTAssertEqual(app.workspace.tasks["user"], rows, "No network request needed for initial display")
        XCTAssertEqual(app.inboxBadgeCount, actions.count)
        StubProtocol.failure = URLError(.notConnectedToInternet)
        await app.refreshTasks(queue: .user, force: true)
        await app.refreshInbox(force: true)
        XCTAssertEqual(app.workspace.tasks["user"], rows)
        XCTAssertEqual(app.workspace.pendingActions, actions)
        XCTAssertNotNil(app.tasksErrors["user"])
        XCTAssertNotNil(app.pendingActionsError)
        XCTAssertEqual(model().workspace.tasks["user"], rows, "Offline relaunch retains rows")
    }

    @MainActor
    func testOneInboxFailureKeepsSavedRowsWhileTheOtherSectionRefreshes() async throws {
        let body = try fixture("pending-actions")
        let actions = try ProtocolDecoder.json.decode(PendingActionsResponse.self, from: body).actions
        try WorkspaceCache(credentials: credentials, directory: directory).save(
            WorkspaceSnapshot(pendingActions: actions, clarifications: []))
        StubProtocol.handler = { request in
            let failing = request.url?.path == "/pending-actions"
            let questions = Data(#"[{"id":"clar_workspace","taskId":"task_fixture","question":"A synthetic question?","context":"","proposedAction":"complete","confidence":null,"sources":[],"status":"pending","answer":null,"answeredAt":null,"createdAt":"2026-01-01T00:00:00Z"}]"#.utf8)
            return (HTTPURLResponse(url: request.url!, statusCode: failing ? 503 : 200, httpVersion: nil, headerFields: nil)!,
                failing ? Data("{}".utf8) : questions)
        }
        let app = model()
        await app.refreshInbox(force: true)
        XCTAssertEqual(app.workspace.pendingActions, actions)
        XCTAssertEqual(app.workspace.clarifications?.first?.id, "clar_workspace")
        XCTAssertNotNil(app.pendingActionsError)
        XCTAssertNil(app.clarificationsError)
        XCTAssertEqual(app.inboxBadgeCount, actions.count + 1)
        XCTAssertEqual(model().workspace.clarifications?.first?.id, "clar_workspace")
    }

    @MainActor
    func testConcurrentRefreshCoalescesAndQueueCachesStaySeparate() async throws {
        let body = try fixture("tasks-list")
        let count = OSAllocatedUnfairLock(initialState: 0)
        StubProtocol.handler = { request in
            count.withLock { $0 += 1 }
            let queue = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "queue" }?.value
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                queue == "agent" ? Data(#"{"tasks":[]}"#.utf8) : body)
        }
        let app = model()
        async let first: Void = app.refreshTasks(queue: .user)
        async let second: Void = app.refreshTasks(queue: .user)
        _ = await (first, second)
        XCTAssertEqual(count.withLock { $0 }, 1)
        await app.refreshTasks(queue: .user)
        XCTAssertEqual(count.withLock { $0 }, 1, "Fresh rows do not trigger duplicate requests")
        await app.refreshTasks(queue: .agent)
        XCTAssertEqual(count.withLock { $0 }, 2)
        XCTAssertFalse(app.workspace.tasks["user"]!.isEmpty)
        XCTAssertEqual(app.workspace.tasks["agent"], [])
    }

    @MainActor
    func testMutationDuringFetchRequiresFreshResponseBeforeCaching() async throws {
        let body = try fixture("tasks-list")
        let count = OSAllocatedUnfairLock(initialState: 0)
        let started = expectation(description: "first request started")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        StubProtocol.handler = { request in
            let n = count.withLock { $0 += 1; return $0 }
            if n == 1 { started.fulfill(); _ = release.wait(timeout: .now() + 5) }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                n == 1 ? body : Data(#"{"tasks":[]}"#.utf8))
        }
        let app = model()
        let refresh = Task { await app.refreshTasks(queue: .user) }
        let result = await XCTWaiter.fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(result, .completed)
        app.bumpTasksGeneration()
        release.signal()
        await refresh.value
        XCTAssertEqual(count.withLock { $0 }, 2)
        XCTAssertEqual(app.workspace.tasks["user"], [])
        XCTAssertEqual(model().workspace.tasks["user"], [])
    }

    @MainActor
    func testDetachedRequestCannotWriteWorkspaceCache() async throws {
        let body = try fixture("tasks-list")
        let started = expectation(description: "old request started")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        StubProtocol.handler = { request in
            started.fulfill(); _ = release.wait(timeout: .now() + 5)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        let app = model()
        let refresh = Task { await app.refreshTasks(queue: .user) }
        let result = await XCTWaiter.fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(result, .completed)
        app.detach(parkedQueue: .parkedForServer(directory: directory))
        release.signal()
        await refresh.value
        XCTAssertNil(app.workspace.tasks["user"])
        XCTAssertTrue(WorkspaceCache(credentials: credentials, directory: directory).load().tasks.isEmpty)
    }
}
