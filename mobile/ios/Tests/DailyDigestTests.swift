import XCTest
@testable import OpenAGI

final class DailyDigestTests: XCTestCase {
    private func plan(_ json: String) throws -> DailyPlanDigest {
        try JSONDecoder().decode(DailyPlanDigest.self, from: Data(json.utf8))
    }

    private func recap(_ json: String) throws -> DailyRecapDigest {
        try JSONDecoder().decode(DailyRecapDigest.self, from: Data(json.utf8))
    }

    func testPlanBodyNamesFocusAndEvents() throws {
        let digest = try plan(#"{"plan":{"focus":[{"title":"Call the dentist"},{"title":"Groceries"},{"title":"Taxes"},{"title":"Gym"}],"counts":{"events":3}},"markdown":"x"}"#)
        XCTAssertEqual(DailyDigestText.planBody(digest), "Focus: Call the dentist, Groceries, and 2 more. 3 events on your calendar.")
        let two = try plan(#"{"plan":{"focus":[{"title":"A"},{"title":"B"}],"counts":{"events":1}}}"#)
        XCTAssertEqual(DailyDigestText.planBody(two), "Focus: A and B. 1 event on your calendar.")
    }

    func testEmptyPlanAndMissingFieldsStillReadWell() throws {
        XCTAssertEqual(DailyDigestText.planBody(try plan(#"{"plan":{}}"#)), "Nothing scheduled yet. Tell me what today should hold.")
        XCTAssertEqual(DailyDigestText.planBody(try plan(#"{"plan":{"focus":[{"title":"Only"}]}}"#)), "Focus: Only.")
    }

    func testRecapBody() throws {
        XCTAssertEqual(DailyDigestText.recapBody(try recap(#"{"recap":{"completedTasks":[{"title":"Ship it"}],"counts":{"completedTasks":1}}}"#)),
                       "You finished 1 task: Ship it.")
        XCTAssertEqual(DailyDigestText.recapBody(try recap(#"{"recap":{"counts":{"completedTasks":0}}}"#)),
                       "No tasks finished yet today. Anything to carry over to tomorrow?")
    }

    @MainActor
    func testFireDatesAreTheNextSevenAtTheJobHour() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 9, minute: 30))!
        let morning = DailyDigestNotifier.fireDates(.plan, from: now, calendar: calendar)
        XCTAssertEqual(morning.count, 7)
        XCTAssertEqual(calendar.dateComponents([.day, .hour], from: morning[0]), DateComponents(day: 17, hour: 8))
        let evening = DailyDigestNotifier.fireDates(.recap, from: now, calendar: calendar)
        XCTAssertEqual(calendar.dateComponents([.day, .hour], from: evening[0]), DateComponents(day: 16, hour: 18))
        XCTAssertEqual(calendar.dateComponents([.day, .hour], from: evening[6]), DateComponents(day: 22, hour: 18))
    }

    @MainActor
    func testTapRoutesByKind() {
        XCTAssertEqual(DailyDigestNotifier.tab(for: ["openagiDigest": "plan"]), .today)
        XCTAssertEqual(DailyDigestNotifier.tab(for: ["openagiDigest": "recap"]), .chat)
        XCTAssertNil(DailyDigestNotifier.tab(for: ["questionId": "q1"]))
    }
}
