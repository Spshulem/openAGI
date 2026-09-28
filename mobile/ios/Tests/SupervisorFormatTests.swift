import XCTest
@testable import OpenAGI

// The Supervisor and Lifelog screens' words and order, pinned to Android's
// SupervisorFormat so both phones describe a thread the same way.
final class SupervisorFormatTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    func testThreadsSortWorstFirstThenMostRecent() {
        let threads = [
            FleetThread(key: "g-old", state: "running", lastActivityAt: now.addingTimeInterval(-600)),
            FleetThread(key: "r", state: "needs-human"),
            FleetThread(key: "g-new", state: "running", lastActivityAt: now),
            FleetThread(key: "gray", state: "excluded"),
            FleetThread(key: "y", state: "idle-no-pr"),
        ]
        XCTAssertEqual(SupervisorFormat.sorted(threads).map(\.key), ["r", "y", "g-new", "g-old", "gray"])
        XCTAssertEqual(SupervisorFormat.summary(threads), "1 red · 1 yellow · 2 green · 1 gray")
    }

    func testNamesAndStatesInPlainWords() {
        XCTAssertEqual(SupervisorFormat.name(FleetThread(key: "k", title: "Title", workspace: " ")), "Title")
        XCTAssertEqual(SupervisorFormat.name(FleetThread(key: "")), "Untitled thread")
        XCTAssertEqual(SupervisorFormat.stateLabel("waiting-ci"), "Waiting on CI")
        XCTAssertEqual(SupervisorFormat.stateLabel("brand-new-state"), "Brand new state")
        XCTAssertEqual(SupervisorFormat.stateLabel(nil), "Unknown")
    }

    func testScanLineAndWarning() {
        XCTAssertEqual(SupervisorFormat.scanLine(lastTickAt: nil, autoScan: false, now: now), "Not scanned yet · Auto-scan off")
        XCTAssertEqual(SupervisorFormat.scanLine(lastTickAt: now.addingTimeInterval(-180), autoScan: true, now: now),
                       "Scanned 3m ago · Auto-scan on")
        XCTAssertEqual(SupervisorFormat.warning(FleetState(lastError: .string("boom"))), "Last scan failed: boom")
        XCTAssertEqual(SupervisorFormat.warning(FleetState(snapshot: FleetSnapshot(sourceErrors: ["codex": .string("x"), "claude": .string("y")]))),
                       "Couldn't read claude, codex on the last scan.")
        XCTAssertNil(SupervisorFormat.warning(FleetState()))
    }

    func testPullRequestChipAndLink() {
        let pr = FleetPR(ref: "Spshulem/openAGI#112", ci: FleetCI(state: "FAILURE"))
        XCTAssertEqual(SupervisorFormat.prChip(pr), "#112 · CI failing")
        XCTAssertTrue(SupervisorFormat.ciFailing(pr.ci))
        XCTAssertEqual(SupervisorFormat.prURL(pr)?.absoluteString, "https://github.com/Spshulem/openAGI/pull/112")
        XCTAssertNil(SupervisorFormat.prURL(FleetPR(ref: "not a ref", url: "https://evil.example/pull/1")))
        XCTAssertEqual(SupervisorFormat.prNumber("local-branch"), "local-branch")
    }

    func testDeliveryNotesAndFailures() {
        XCTAssertEqual(SupervisorFormat.deliveryNote(FleetDelivery(status: "sent"), fallback: "Answered."),
                       .init(text: "Sent to the agent.", isAlert: false))
        XCTAssertEqual(SupervisorFormat.deliveryNote(FleetDelivery(status: "blocked", detail: " offline "), fallback: "x"),
                       .init(text: "Saved. Couldn't reach the agent: offline", isAlert: true))
        XCTAssertEqual(SupervisorFormat.deliveryNote(nil, fallback: "Answered."), .init(text: "Answered.", isAlert: false))
        XCTAssertFalse(SupervisorFormat.failureNote(.transport(URLError(.timedOut))).isAlert)
        XCTAssertEqual(SupervisorFormat.failureNote(.conflict).text, "That's already been handled.")
        XCTAssertEqual(SupervisorFormat.errorCopy(.unauthorized).headline, "Supervisor isn't open to this phone.")
    }

    func testProposedNudgesForAThread() {
        let thread = FleetThread(key: "t1")
        let actions = [
            FleetAction(id: "a", status: "proposed", threadKey: "t1"),
            FleetAction(id: "b", status: "sent", threadKey: "t1"),
            FleetAction(id: "c", status: "proposed", targetKey: "t1"),
            FleetAction(id: "d", status: "proposed", threadKey: "t2"),
        ]
        XCTAssertEqual(SupervisorFormat.proposed(for: thread, in: actions).map(\.id), ["a", "c"])
    }

    func testLifelogDayAndMeta() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let start = ISO8601DateFormatter().date(from: "2026-09-28T22:40:00Z")!
        XCTAssertEqual(LifelogFormat.dayString(start, calendar: calendar), "2026-09-28")
        XCTAssertEqual(LifelogFormat.dayString(ISO8601DateFormatter().date(from: "2026-09-29T02:00:00Z")!, calendar: calendar), "2026-09-28")
        let moment = LifelogMoment(id: "1", deviceName: "Spencer's G2", at: start, endAt: start.addingTimeInterval(720))
        XCTAssertEqual(LifelogFormat.meta(moment, calendar: calendar), "3:40 PM – 3:52 PM · Spencer's G2")
        XCTAssertEqual(LifelogFormat.errorCopy(.notFound).headline, "Update OpenAGI on your main.")
    }
}
