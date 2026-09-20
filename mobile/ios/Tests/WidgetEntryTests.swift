import XCTest
import WidgetKit
@testable import OpenAGI

// WidgetState.from is a pure function: it takes `paired` as a parameter
// instead of reading the Keychain itself, because a unit-test bundle cannot
// arrange Keychain state, and because this makes it the literal twin of
// Android's WidgetState.from. The timeline provider is what actually supplies
// `paired: Credentials.load() != nil`.
final class WidgetEntryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func summary(titles: [String]) -> MobileSummary {
        let today = titles.enumerated().map { index, title in
            TaskItem(id: "task_\(index)", title: title, bucket: "today", status: "pending",
                     priority: 50, dueDate: nil, overdue: false)
        }
        return MobileSummary(
            generatedAt: now,
            today: today,
            counts: .init(today: today.count, thisWeek: 0, overdue: 0, pendingActions: 0),
            pendingActions: [],
            brief: .init(headline: "\(today.count) things today")
        )
    }

    private func snapshot(titles: [String], ageMinutes: Int, locallyCompleted: Set<String> = []) -> Snapshot {
        Snapshot(summary: summary(titles: titles),
                 fetchedAt: now.addingTimeInterval(TimeInterval(-ageMinutes * 60)),
                 etag: nil,
                 locallyCompleted: locallyCompleted)
    }

    // 1. `paired: false` -> `.unpaired`, whatever the snapshot holds.
    func testUnpairedOverridesAnyLocalSnapshot() {
        let state = WidgetState.from(snapshot: snapshot(titles: ["A"], ageMinutes: 0), paired: false, now: now)
        XCTAssertEqual(state, .unpaired)
    }

    // 2. `paired: true`, `snapshot: nil` -> `.empty` with a non-empty headline.
    func testPairedWithNoSnapshotIsEmptyWithANonEmptyHeadline() {
        let state = WidgetState.from(snapshot: nil, paired: true, now: now)
        guard case let .empty(headline) = state else { return XCTFail("expected .empty, got \(state)") }
        XCTAssertFalse(headline.isEmpty)
    }

    // 3. Snapshot with two visible tasks, fetched 3 minutes ago -> `.tasks`
    // with both titles and `ageMinutes == 3`.
    func testFreshSnapshotWithVisibleTasksReturnsTasksState() {
        let state = WidgetState.from(snapshot: snapshot(titles: ["A", "B"], ageMinutes: 3), paired: true, now: now)
        guard case let .tasks(tasks, counts, ageMinutes) = state else { return XCTFail("expected .tasks, got \(state)") }
        XCTAssertEqual(tasks.map(\.title), ["A", "B"])
        XCTAssertEqual(ageMinutes, 3)
        XCTAssertEqual(counts.today, 2)
    }

    // 4. Snapshot fetched 61 minutes ago -> `.stale(61)` -- past an hour the
    // widget must say so rather than present old rows as current.
    func testSnapshotOlderThanStaleAfterMinutesIsStale() {
        let state = WidgetState.from(snapshot: snapshot(titles: ["A"], ageMinutes: 61), paired: true, now: now)
        XCTAssertEqual(state, .stale(61))
        XCTAssertEqual(WidgetState.staleAfterMinutes, 60)
    }

    // 5. Snapshot whose only task was optimistically completed -> `.empty`.
    func testSnapshotWithOnlyOptimisticallyCompletedTaskIsEmpty() {
        let state = WidgetState.from(snapshot: snapshot(titles: ["A"], ageMinutes: 3, locallyCompleted: ["task_0"]),
                                      paired: true, now: now)
        guard case .empty = state else { return XCTFail("expected .empty, got \(state)") }
    }

    // Not one of the five enumerated cases above, but TodayEntry is the
    // other type this file is responsible for pinning: the TimelineEntry the
    // provider hands to WidgetKit. This is also what makes Step 2's RED run
    // fail with "cannot find 'TodayEntry' in scope" rather than only a
    // WidgetState failure.
    func testTodayEntryCarriesItsDateAndState() {
        let entry = TodayEntry(date: now, state: .unpaired)
        XCTAssertEqual(entry.date, now)
        XCTAssertEqual(entry.state, .unpaired)
    }
}
