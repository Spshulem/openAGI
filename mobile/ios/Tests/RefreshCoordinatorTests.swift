import XCTest
import os
@testable import OpenAGI

// Reuses `StubProtocol` from DaemonClientTests.swift (same test target).
final class RefreshCoordinatorTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(filePath: NSTemporaryDirectory()).appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        StubProtocol.handler = nil
        StubProtocol.failure = nil
        StubProtocol.lastRequest = nil
    }

    private func makeClient() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(
            server: URL(string: "http://mac.tail1234.ts.net:43210")!,
            nodeID: "mobile:abc",
            token: String(repeating: "a", count: 43),
            session: URLSession(configuration: config)
        )
    }

    // Mirrors SnapshotStoreTests' `summary(ids:)`: the id is exactly the
    // given string so a fixture built here can be compared across two
    // separately-constructed summaries (open vs. closed).
    private func summary(ids: [String]) -> MobileSummary {
        let today = ids.map { id in
            TaskItem(id: id, title: id, bucket: "today", status: "pending",
                     priority: 50, dueDate: nil, overdue: false)
        }
        return MobileSummary(
            generatedAt: Date(),
            today: today,
            counts: .init(today: today.count, thisWeek: 0, overdue: 0, pendingActions: 0),
            pendingActions: [],
            brief: .init(headline: "\(today.count) things today")
        )
    }

    private func populatedFixture() throws -> Data {
        try Data(contentsOf: URL(filePath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "fixtures/summary-populated.json"))
    }

    private func response(_ code: Int, headers: [String: String]? = nil, body: Data = Data()) -> (URLRequest) -> (HTTPURLResponse, Data) {
        { request in (HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!, body) }
    }

    // 1. 200 with the populated fixture leaves the stored snapshot with the
    // fixture's two tasks and reports `.updated`.
    func testRefreshWritesTheSnapshotAndReturnsUpdated() async throws {
        let fixture = try populatedFixture()
        StubProtocol.handler = response(200, headers: ["ETag": "\"abc\""], body: fixture)
        let store = SnapshotStore(directory: dir)
        let coordinator = RefreshCoordinator(client: makeClient(), store: store, queue: OutboundQueue(directory: dir))

        let outcome = await coordinator.refresh()

        guard case .updated = outcome else { return XCTFail("expected .updated, got \(outcome)") }
        XCTAssertEqual(store.load()?.summary.today.count, 2)
    }

    // 2. Seed a snapshot, respond 304: the stored `fetchedAt` is refreshed
    // but `today` is untouched, and the outcome is `.unchanged`.
    func testUnchangedLeavesTheExistingSnapshotAlone() async throws {
        let store = SnapshotStore(directory: dir)
        let seeded = Snapshot(summary: summary(ids: ["task_0"]), fetchedAt: Date().addingTimeInterval(-600),
                               etag: "\"abc\"", locallyCompleted: [])
        try store.save(seeded)
        StubProtocol.handler = response(304)
        let coordinator = RefreshCoordinator(client: makeClient(), store: store, queue: OutboundQueue(directory: dir))

        let outcome = await coordinator.refresh()

        guard case .unchanged = outcome else { return XCTFail("expected .unchanged, got \(outcome)") }
        let reloaded = try XCTUnwrap(store.load())
        XCTAssertEqual(reloaded.summary.today.map(\.id), ["task_0"], "today must be untouched on a 304")
        XCTAssertGreaterThan(reloaded.fetchedAt, seeded.fetchedAt, "fetchedAt must be refreshed on a 304")
    }

    // 3. Enqueue `.completeTask("task_0")`, respond 200: the queue is empty
    // and the request path was `/tasks/task_0/complete`.
    func testDrainSendsQueuedCompletionsAndClearsThem() async throws {
        let queue = OutboundQueue(directory: dir)
        try queue.enqueue(PendingOp(kind: .completeTask("task_0")))
        StubProtocol.handler = response(200, body: Data("{}".utf8))
        let coordinator = RefreshCoordinator(client: makeClient(), store: SnapshotStore(directory: dir), queue: queue)

        await coordinator.drainQueue()

        XCTAssertTrue(queue.all().isEmpty)
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path, "/tasks/task_0/complete")
    }

    // 4. Respond 404: the queue is empty (the task is gone server-side;
    // replaying forever is pointless).
    func testA404DuringDrainRetiresTheOpRatherThanRetrying() async throws {
        let queue = OutboundQueue(directory: dir)
        try queue.enqueue(PendingOp(kind: .completeTask("task_0")))
        StubProtocol.handler = response(404)
        let coordinator = RefreshCoordinator(client: makeClient(), store: SnapshotStore(directory: dir), queue: queue)

        await coordinator.drainQueue()

        XCTAssertTrue(queue.all().isEmpty, "a 404 means the task is already gone server-side")
    }

    // Not enumerated by name in the brief, but the brief's own retirement
    // rule ("A 404 or 409 retires a queued op rather than retrying it") and
    // the coordinator's `catch DaemonError.notFound, DaemonError.conflict`
    // branch treat both codes identically. This pins the 409 half of that
    // branch the same way test 4 pins the 404 half.
    func testA409DuringDrainRetiresTheOpRatherThanRetrying() async throws {
        let queue = OutboundQueue(directory: dir)
        try queue.enqueue(PendingOp(kind: .completeTask("task_0")))
        StubProtocol.handler = response(409)
        let coordinator = RefreshCoordinator(client: makeClient(), store: SnapshotStore(directory: dir), queue: queue)

        await coordinator.drainQueue()

        XCTAssertTrue(queue.all().isEmpty, "a 409 means the server already considers this done")
    }

    // Finding 2 (Task 9 review): drainQueue's `catch DaemonError.notFound,
    // DaemonError.conflict` branch retires an op (tested above by 4 and this
    // 409 test); every other error falls to the generic `catch` and calls
    // `queue.recordAttempt` instead. Nothing before this exercised that
    // second branch through the coordinator's own dispatch --
    // OutboundQueueTests only calls `recordAttempt` directly, never through
    // `drainQueue()`. A mutation collapsing both catch clauses into "remove
    // on any error" passes the rest of the suite (nothing else distinguishes
    // them) but must fail this one.
    func testA500DuringDrainRecordsAnAttemptRatherThanRetiringTheOp() async throws {
        let queue = OutboundQueue(directory: dir)
        let op = PendingOp(kind: .completeTask("task_0"))
        try queue.enqueue(op)
        StubProtocol.handler = response(500)
        let coordinator = RefreshCoordinator(client: makeClient(), store: SnapshotStore(directory: dir), queue: queue)

        await coordinator.drainQueue()

        let remaining = try XCTUnwrap(queue.all().first)
        XCTAssertEqual(remaining.id, op.id, "a 500 is not the server saying it's done -- the op must still be queued")
        XCTAssertEqual(remaining.attempts, 1, "the failed attempt must be recorded so the cap eventually retires it")
    }

    // 5. Respond 401: `.unauthorized`, and the cached snapshot still loads
    // so the user sees their tasks while they re-pair.
    func testAnUnauthorizedRefreshReportsUnauthorizedAndKeepsTheSnapshot() async throws {
        let store = SnapshotStore(directory: dir)
        let seeded = Snapshot(summary: summary(ids: ["task_0"]), fetchedAt: Date(), etag: "\"abc\"", locallyCompleted: [])
        try store.save(seeded)
        StubProtocol.handler = response(401)
        let coordinator = RefreshCoordinator(client: makeClient(), store: store, queue: OutboundQueue(directory: dir))

        let outcome = await coordinator.refresh()

        guard case .unauthorized = outcome else { return XCTFail("expected .unauthorized, got \(outcome)") }
        XCTAssertEqual(store.load()?.summary.today.map(\.id), ["task_0"],
                       "the cached snapshot must still be visible while the user re-pairs")
    }

    // Whole-branch review finding: `heartbeat()` was implemented and tested
    // in isolation but never actually called from anywhere -- not this
    // coordinator, not the app, not a view -- so a paired phone's `lastSeen`
    // never advanced past enrollment. `refresh()` is the one place that
    // covers foreground, pull-to-refresh, and background refresh, so this
    // pins that it fires from there with the exact method/path the daemon
    // requires.
    func testRefreshSendsAHeartbeat() async throws {
        let fixture = try populatedFixture()
        let seenRequests = OSAllocatedUnfairLock(initialState: [URLRequest]())
        StubProtocol.handler = { request in
            seenRequests.withLock { $0.append(request) }
            if request.url?.path == "/nodes/heartbeat" {
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"ok":true}"#.utf8))
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["ETag": "\"abc\""])!, fixture)
        }
        let coordinator = RefreshCoordinator(client: makeClient(), store: SnapshotStore(directory: dir), queue: OutboundQueue(directory: dir))

        _ = await coordinator.refresh()

        let heartbeats = seenRequests.withLock { $0 }.filter { $0.url?.path == "/nodes/heartbeat" }
        XCTAssertEqual(heartbeats.count, 1, "refresh() must send exactly one heartbeat so the daemon's node roster shows this phone as recently seen")
        XCTAssertEqual(heartbeats.first?.httpMethod, "POST")
    }

    // Whole-branch review finding: `RefreshOutcome.offline` never reached the
    // snapshot, so the widget -- which only reads what's on disk -- had no
    // way to distinguish "the daemon has been down for hours" from "healthy,
    // just polled recently" short of the unrelated 60-minute staleness
    // threshold.
    func testAnOfflineRefreshRecordsTheFailureOnTheSnapshotForTheWidget() async throws {
        let store = SnapshotStore(directory: dir)
        try store.save(Snapshot(summary: summary(ids: ["task_0"]), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        StubProtocol.failure = URLError(.notConnectedToInternet)
        defer { StubProtocol.failure = nil }
        let coordinator = RefreshCoordinator(client: makeClient(), store: store, queue: OutboundQueue(directory: dir))

        let outcome = await coordinator.refresh()

        guard case .offline = outcome else { return XCTFail("expected .offline, got \(outcome)") }
        XCTAssertNotNil(store.load()?.lastRefreshFailedAt, "an offline refresh must record the failure so the widget can render it")
    }

    // Not enumerated by name in the brief, but the brief's design note says
    // the coordinator drains BEFORE fetching "or a fetch overwrites the
    // snapshot with server state that predates the user's queued
    // completion, and the row the user just ticked flickers back." This
    // test fails if that order is swapped: the stub only stops listing
    // task_0 once it has received the POST, so a fetch-before-drain would
    // observably resurrect task_0 in the stored snapshot.
    func testRefreshDrainsTheQueueBeforeFetchingSoATickedTaskDoesNotReappear() async throws {
        let store = SnapshotStore(directory: dir)
        let queue = OutboundQueue(directory: dir)
        try store.save(Snapshot(summary: summary(ids: ["task_0", "task_1"]), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        try queue.enqueue(PendingOp(kind: .completeTask("task_0")))

        let serverHasSeenTheCompletion = OSAllocatedUnfairLock(initialState: false)
        let openBody = try ProtocolDecoder.jsonEncoder.encode(summary(ids: ["task_0", "task_1"]))
        let closedBody = try ProtocolDecoder.jsonEncoder.encode(summary(ids: ["task_1"]))
        StubProtocol.handler = { request in
            if request.url?.path == "/tasks/task_0/complete" {
                serverHasSeenTheCompletion.withLock { $0 = true }
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
            }
            let stillOpen = !serverHasSeenTheCompletion.withLock { $0 }
            let body = stillOpen ? openBody : closedBody
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["ETag": "\"x\""])!, body)
        }
        let coordinator = RefreshCoordinator(client: makeClient(), store: store, queue: queue)

        _ = await coordinator.refresh()

        XCTAssertEqual(store.load()?.summary.today.map(\.id), ["task_1"],
                       "a fetch-before-drain would still see task_0 as open and resurrect it")
        XCTAssertTrue(queue.all().isEmpty)
    }
}
