import XCTest
@testable import OpenAGI

final class SessionActivityTests: XCTestCase {
    func testOldPayloadsDefaultBlockedToZero() throws {
        let activity = try JSONDecoder().decode(SupervisorActivityPlaintext.self,
            from: Data(#"{"counts":{"you":1,"working":2,"waiting":1}}"#.utf8))
        XCTAssertEqual(activity.counts.blocked, 0)
        XCTAssertFalse(activity.partial)
        XCTAssertEqual(activity.countsLine, "1 needs you · 2 working · 1 waiting")
    }

    func testBlockedCountsAndFreshnessUseScanInsteadOfDelivery() throws {
        let activity = try JSONDecoder().decode(SupervisorActivityPlaintext.self, from: Data(#"""
            {"at":"2026-10-28T12:00:00Z","observedAt":"2026-10-28T10:00:00Z",
             "partial":true,"counts":{"you":2,"working":3,"blocked":1}}
            """#.utf8))
        XCTAssertEqual(activity.countsLine, "2 needs you · 1 blocked · 3 working")
        XCTAssertTrue(activity.partial)
        XCTAssertTrue(activity.isOutdated(now: activity.atDate!))
        XCTAssertFalse(activity.isOutdated(now: activity.observedDate!.addingTimeInterval(29 * 60)))
        XCTAssertTrue(activity.isOutdated(now: activity.observedDate!.addingTimeInterval(30 * 60)))
        XCTAssertTrue(SupervisorActivityPlaintext().isOutdated())
        let unknownScan = try JSONDecoder().decode(SupervisorActivityPlaintext.self,
            from: Data(#"{"at":"2026-10-28T12:00:00Z","observedAt":null}"#.utf8))
        XCTAssertTrue(unknownScan.isOutdated(now: activity.atDate!))
    }

    func testExactSessionLinksRoundTripReservedCharacters() {
        let key = "codex:abc/a?b=c&d=space + 🔧"
        XCTAssertEqual(SupervisorLink.threadKey(in: SupervisorLink.url(threadKey: key)), key)
        XCTAssertNil(SupervisorLink.threadKey(in: SupervisorLink.url()))
        XCTAssertNil(SupervisorLink.threadKey(in: URL(string: "https://example.com/?thread=secret")!))
        XCTAssertNil(SupervisorLink.threadKey(in: URL(string: "openagi://pair?thread=wrong")!))
    }

    @MainActor
    func testShortcutHandoffDoesNotLoseSessionOnColdLaunch() {
        let router = PushRouter()
        router.openSupervisor(threadKey: "codex:exact")
        XCTAssertTrue(router.wantsSupervisor)
        XCTAssertEqual(router.threadKey, "codex:exact")
        router.wantsSupervisor = false
        XCTAssertEqual(router.threadKey, "codex:exact", "tab routing must leave the session for Supervisor to consume")
        router.openSupervisor()
        XCTAssertNil(router.threadKey)
        XCTAssertEqual(router.supervisorRequest, 2, "overview requests must also dismiss an existing session")
    }
}
