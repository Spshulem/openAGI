import XCTest
@testable import OpenAGI

final class RelativeTimeTests: XCTestCase {
    func testCompactFormatsAcrossTheMinuteHourDayBoundaries() {
        XCTAssertEqual(RelativeTime.compact(minutes: 0), "now")
        XCTAssertEqual(RelativeTime.compact(minutes: 1), "1m")
        XCTAssertEqual(RelativeTime.compact(minutes: 59), "59m")
        XCTAssertEqual(RelativeTime.compact(minutes: 60), "1h")
        XCTAssertEqual(RelativeTime.compact(minutes: 179), "2h")
        XCTAssertEqual(RelativeTime.compact(minutes: 24 * 60), "1d")
    }

    func testCompactClampsNegativeMinutesToZero() {
        XCTAssertEqual(RelativeTime.compact(minutes: -5), "now")
    }

    // DESIGN.md's exact stale-widget copy: "Last synced 3h ago".
    func testLastSyncedMatchesDESIGNsExactCopy() {
        XCTAssertEqual(RelativeTime.lastSynced(minutes: 180), "Last synced 3h ago")
        XCTAssertEqual(RelativeTime.lastSynced(minutes: 0), "Last synced just now")
    }

    func testUpdatedMatchesTheStatusLineCopy() {
        XCTAssertEqual(RelativeTime.updated(minutes: 0), "Updated just now")
        XCTAssertEqual(RelativeTime.updated(minutes: 5), "Updated 5m ago")
    }
}

final class ConnectionDotStateTests: XCTestCase {
    // DESIGN.md: "Dot (6pt, live filled when synced under 60 min, muted
    // hollow when older, alert filled when the last refresh failed)."
    func testAFailedRefreshIsAlertRegardlessOfAge() {
        XCTAssertEqual(ConnectionDotState.derive(ageMinutes: 0, refreshFailed: true), .failed)
        XCTAssertEqual(ConnectionDotState.derive(ageMinutes: 500, refreshFailed: true), .failed)
    }

    func testUnderSixtyMinutesWithNoFailureIsFresh() {
        XCTAssertEqual(ConnectionDotState.derive(ageMinutes: 0, refreshFailed: false), .fresh)
        XCTAssertEqual(ConnectionDotState.derive(ageMinutes: 59, refreshFailed: false), .fresh)
    }

    func testAtOrOverSixtyMinutesWithNoFailureIsStale() {
        XCTAssertEqual(ConnectionDotState.derive(ageMinutes: 60, refreshFailed: false), .stale)
        XCTAssertEqual(ConnectionDotState.derive(ageMinutes: 61, refreshFailed: false), .stale)
    }
}
