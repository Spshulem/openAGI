import XCTest
import os
@testable import OpenAGI

final class AppModelRefreshTests: XCTestCase {
    private var directory: URL!

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
        try Data(contentsOf: URL(filePath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "fixtures/\(name).json"))
    }

    @MainActor
    private func model() -> AppModel {
        let credentials = Credentials(server: URL(string: "https://daemon.example.com")!,
                                      nodeID: "mobile:fixture", token: "synthetic-test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID,
                                  token: credentials.token, session: URLSession(configuration: configuration))
        return AppModel(credentials: credentials, client: client,
                        store: SnapshotStore(directory: directory), queue: OutboundQueue(directory: directory),
                        chatDirectory: directory)
    }

    private func servePopulatedData(summaryStatus: Int = 200) throws {
        let summary = try fixture("summary-populated")
        let actions = try fixture("pending-actions")
        let clarification = Data(#"[{"id":"clar_fixture","taskId":"task_fixture","question":"Finished?","context":"","proposedAction":"complete","confidence":null,"sources":[],"status":"pending","answer":null,"answeredAt":null,"createdAt":"2026-01-01T00:00:00Z"}]"#.utf8)
        StubProtocol.handler = { request in
            let status: Int
            let data: Data
            switch request.url?.path {
            case "/mobile/summary":
                status = summaryStatus
                data = summaryStatus == 304 ? Data() : summary
            case "/pending-actions": status = 200; data = actions
            case "/tasks/clarifications": status = 200; data = clarification
            default: status = 200; data = Data("{}".utf8)
            }
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                    headerFields: ["ETag": "fixture-etag"])!, data)
        }
    }

    @MainActor
    func testDetachedRefreshCannotOverwriteTheNextPairingsSnapshot() async throws {
        let model = model()
        let body = try fixture("summary-populated")
        let started = expectation(description: "old summary in flight")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        StubProtocol.handler = { request in
            if request.url?.path == "/mobile/summary" {
                started.fulfill()
                _ = release.wait(timeout: .now() + 5)
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        let refresh = Task { await model.refreshToday() }
        let result = await XCTWaiter.fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(result, .completed)
        model.detach(parkedQueue: .parkedForServer(directory: directory))
        let nextSummary = try ProtocolDecoder.json.decode(MobileSummary.self, from: body)
        _ = try model.store.storeFresh(summary: nextSummary, etag: "next-pairing")
        release.signal()
        await refresh.value
        XCTAssertEqual(model.store.load()?.etag, "next-pairing")
        XCTAssertNil(model.lastOutcome)
        XCTAssertFalse(model.isRefreshingToday)
        await model.refreshToday()
        XCTAssertEqual(model.store.load()?.etag, "next-pairing")
    }

    @MainActor
    func testRefreshUpdatesTheVisibleTodayAndInvalidatesBothLists() async throws {
        let model = model()
        try servePopulatedData()
        let tasksBefore = model.tasksGeneration
        let inboxBefore = model.inboxGeneration

        await model.refreshData()

        XCTAssertEqual(model.snapshot?.visibleToday.count, 3)
        XCTAssertEqual(model.inboxBadgeCount, 2)
        XCTAssertGreaterThan(model.tasksGeneration, tasksBefore)
        XCTAssertGreaterThan(model.inboxGeneration, inboxBefore)
    }

    @MainActor
    func testReconnectRecoversAfterAnOfflineInitialLoad() async throws {
        let model = model()
        StubProtocol.failure = URLError(.notConnectedToInternet)
        await model.refreshData()
        XCTAssertNil(model.snapshot)
        XCTAssertTrue(model.refreshFailed)

        StubProtocol.failure = nil
        try servePopulatedData()
        await model.refreshData()

        XCTAssertEqual(model.snapshot?.visibleToday.count, 3)
        XCTAssertEqual(model.inboxBadgeCount, 2)
        XCTAssertFalse(model.refreshFailed)
    }

    @MainActor
    func testResumeLoadsABackgroundSnapshotEvenWhenTheServerReturns304() async throws {
        let model = model()
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-populated"))
        _ = try model.store.storeFresh(summary: summary, etag: "fixture-etag")
        XCTAssertNil(model.snapshot, "A background disk write does not update the visible model")
        try servePopulatedData(summaryStatus: 304)

        await model.refreshData()

        XCTAssertEqual(model.snapshot?.visibleToday.count, 3)
        XCTAssertEqual(model.inboxBadgeCount, 2)
    }

    @MainActor
    func testOverlappingResumeAndTodayRefreshSendAnOfflineCompletionOnce() async throws {
        let model = model()
        try model.queue.enqueue(PendingOp(kind: .completeTask("task_offline")))
        let summary = try fixture("summary-populated")
        let requests = OSAllocatedUnfairLock(initialState: (completions: 0, summaries: 0))
        let completionStarted = expectation(description: "offline completion is in flight")
        let completionRelease = DispatchSemaphore(value: 0)
        defer { completionRelease.signal() }
        StubProtocol.handler = { request in
            let body: Data
            switch request.url?.path {
            case "/tasks/task_offline/complete":
                let first = requests.withLock { state in
                    state.completions += 1
                    return state.completions == 1
                }
                if first {
                    completionStarted.fulfill()
                    _ = completionRelease.wait(timeout: .now() + 5)
                }
                body = Data("{}".utf8)
            case "/mobile/summary":
                requests.withLock { $0.summaries += 1 }
                body = summary
            case "/pending-actions", "/tasks/clarifications": body = Data("[]".utf8)
            default: body = Data("{}".utf8)
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: nil)!, body)
        }

        let resume = Task { await model.refreshData() }
        let started = await XCTWaiter.fulfillment(of: [completionStarted], timeout: 2)
        XCTAssertEqual(started, .completed)
        let todayStarted = expectation(description: "Today joins the pending refresh")
        let today = Task {
            todayStarted.fulfill()
            await model.refreshToday()
        }
        let overlapping = await XCTWaiter.fulfillment(of: [todayStarted], timeout: 2)
        XCTAssertEqual(overlapping, .completed)
        completionRelease.signal()
        await resume.value
        await today.value

        XCTAssertEqual(requests.withLock { $0.completions }, 1)
        XCTAssertEqual(requests.withLock { $0.summaries }, 1)
        XCTAssertTrue(model.queue.all().isEmpty)
        XCTAssertEqual(model.snapshot?.visibleToday.count, 3)
        XCTAssertFalse(model.isRefreshingToday)

        await model.refreshToday()
        XCTAssertEqual(requests.withLock { $0.summaries }, 2, "A later refresh must still fetch new data")
        XCTAssertEqual(requests.withLock { $0.completions }, 1)
    }
}
