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

    func testServerStateWinsOnTheNextFetch() throws {
        let store = SnapshotStore(directory: dir)
        try store.save(Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        _ = try store.applyOptimisticCompletion(taskID: "task_0")
        // The server still reports task_0 as open — a refresh must not resurrect
        // the optimistic hide forever, but it also must not flicker it back
        // while the completion is still queued. The rule: a fresh fetch clears
        // only the optimistic ids the server no longer lists.
        try store.save(Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: nil,
                                locallyCompleted: ["task_0"]))
        XCTAssertEqual(try XCTUnwrap(store.load()).visibleToday.map(\.title), ["B"])
        try store.save(Snapshot(summary: try summary(titles: ["B"]), fetchedAt: Date(), etag: nil,
                                locallyCompleted: []))
        XCTAssertEqual(try XCTUnwrap(store.load()).visibleToday.map(\.title), ["B"])
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
