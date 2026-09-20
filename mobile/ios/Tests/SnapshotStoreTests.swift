import XCTest
@testable import OpenAGI

final class SnapshotStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(filePath: NSTemporaryDirectory()).appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func summary(titles: [String]) throws -> MobileSummary {
        let today = titles.enumerated().map { index, title in
            TaskItem(id: "task_\(index)", title: title, bucket: "today", status: "pending",
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

    // Unlike `summary(titles:)`, the id here is exactly the given string, not
    // a position-derived "task_N" that changes meaning when the list shrinks.
    // The storeFresh tests below need ids that stay stable across two
    // separately-constructed summaries, so they use this instead.
    private func summary(ids: [String]) throws -> MobileSummary {
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

    func testRoundTrips() throws {
        let store = SnapshotStore(directory: dir)
        XCTAssertNil(store.load())
        let snapshot = Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: "\"x\"", locallyCompleted: [])
        try store.save(snapshot)
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.summary.today.map(\.title), ["A", "B"])
        XCTAssertEqual(loaded.etag, "\"x\"")
    }

    func testOptimisticCompletionHidesTheTaskImmediately() throws {
        let store = SnapshotStore(directory: dir)
        try store.save(Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        let updated = try XCTUnwrap(try store.applyOptimisticCompletion(taskID: "task_0"))
        XCTAssertEqual(updated.visibleToday.map(\.title), ["B"])
        XCTAssertEqual(updated.visibleCounts.today, 1)
        // And it survives a reload, because the widget process may be different.
        XCTAssertEqual(try XCTUnwrap(store.load()).visibleToday.map(\.title), ["B"])
    }

    // storeFresh's `previous.intersection(stillOpen)` is the only place this
    // intersection runs, and it is the core correctness property of this
    // task: an id the user optimistically completed must stop being
    // suppressed once the server agrees it's done (or it stays invisible
    // forever), and an id the server still reports open must stay suppressed
    // (or the row flickers back under the user's finger). These two tests
    // call storeFresh directly and assert on the stored `locallyCompleted`
    // set itself, not just on `visibleToday`, and each one mixes an id that
    // should stay with an id that should go so it independently fails under
    // either a union or an unconditional clear (verified by hand — see the
    // task-8 fix report).
    func testStoreFreshKeepsAnOptimisticCompletionTheServerStillReportsOpen() throws {
        let store = SnapshotStore(directory: dir)
        // task_0 was completed locally but the server hasn't caught up yet;
        // task_1 was never touched. Both are still open in the fresh fetch.
        try store.save(Snapshot(summary: try summary(ids: ["task_0", "task_1"]), fetchedAt: Date(), etag: nil,
                                locallyCompleted: ["task_0"]))
        let fresh = try store.storeFresh(summary: try summary(ids: ["task_0", "task_1"]), etag: "\"fresh\"")
        // Exact-set equality matters here: a union would also fold task_1 in
        // (it's "still open" too, just never completed), which this catches.
        XCTAssertEqual(fresh.locallyCompleted, ["task_0"])
        XCTAssertEqual(fresh.visibleToday.map(\.id), ["task_1"])
        XCTAssertEqual(try XCTUnwrap(store.load()).locallyCompleted, ["task_0"])
    }

    func testStoreFreshDropsAnOptimisticCompletionOnceTheServerAgrees() throws {
        let store = SnapshotStore(directory: dir)
        // task_0 is completed locally and the server has now caught up: it no
        // longer appears in today's list, so it must be dropped. task_2 is
        // also completed locally but the server still lists it open, so it
        // must survive — that's what stops this test from also passing under
        // an unconditional clear (which would drop task_2 too).
        try store.save(Snapshot(summary: try summary(ids: ["task_0", "task_2"]), fetchedAt: Date(), etag: nil,
                                locallyCompleted: ["task_0", "task_2"]))
        let fresh = try store.storeFresh(summary: try summary(ids: ["task_1", "task_2"]), etag: "\"fresh\"")
        XCTAssertEqual(fresh.locallyCompleted, ["task_2"])
        XCTAssertEqual(Set(fresh.visibleToday.map(\.id)), ["task_1"])
        XCTAssertEqual(try XCTUnwrap(store.load()).locallyCompleted, ["task_2"])
    }

    func testConcurrentOptimisticCompletionsDoNotLoseAnUpdate() throws {
        // Same rationale as OutboundQueueTests's concurrency test: a unit
        // test bundle cannot host two real processes, so this races many
        // threads through applyOptimisticCompletion's read-modify-write
        // against the same file. It proves the coordinated block serializes
        // this in-process race so no completion is lost; it does NOT prove
        // cross-process behavior.
        let store = SnapshotStore(directory: dir)
        let ids = (0..<12).map { "task_\($0)" }
        try store.save(Snapshot(summary: try summary(ids: ids), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        DispatchQueue.concurrentPerform(iterations: ids.count) { index in
            _ = try? store.applyOptimisticCompletion(taskID: ids[index])
        }
        XCTAssertEqual(try XCTUnwrap(store.load()).locallyCompleted, Set(ids))
    }

    func testCorruptFileIsTreatedAsNoSnapshotRatherThanCrashing() throws {
        let store = SnapshotStore(directory: dir)
        try Data("not json".utf8).write(to: dir.appending(path: "snapshot.json"))
        XCTAssertNil(store.load())
    }

    func testStalenessIsComputable() throws {
        let store = SnapshotStore(directory: dir)
        let old = Date().addingTimeInterval(-900)
        try store.save(Snapshot(summary: try summary(titles: ["A"]), fetchedAt: old, etag: nil, locallyCompleted: []))
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.ageInMinutes(now: old.addingTimeInterval(900)), 15)
    }
}
