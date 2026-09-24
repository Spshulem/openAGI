import XCTest
@testable import OpenAGI

// `mobile/fixtures/tasks-list.json` is generated from a real daemon
// (scripts/generate-mobile-fixtures.mjs) -- decoding it here is what stops
// `TaskRecord` from drifting away from `GET /tasks`'s actual shape, the same
// role SummaryDecodingTests plays for `MobileSummary`.
final class TaskRecordDecodingTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let here = URL(filePath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appending(path: "fixtures/\(name).json"))
    }

    func testDecodesTheTasksListResponse() throws {
        let response = try ProtocolDecoder.json.decode(TasksListResponse.self, from: fixture("tasks-list"))
        XCTAssertFalse(response.tasks.isEmpty)
        let first = try XCTUnwrap(response.tasks.first)
        XCTAssertEqual(first.title, "Ship the widget")
        XCTAssertEqual(first.queue, "user")
        XCTAssertEqual(first.bucket, "today")
        XCTAssertEqual(first.status, "pending")
        XCTAssertNil(first.completedAt)
        XCTAssertNil(first.completedVia)
    }

    func testOverdueTaskDecodesItsDueDateAsARealDate() throws {
        let response = try ProtocolDecoder.json.decode(TasksListResponse.self, from: fixture("tasks-list"))
        let overdue = try XCTUnwrap(response.tasks.first { $0.title == "Renew the domain" })
        XCTAssertNotNil(overdue.dueDate)
    }

    // The task store holds "" for a cleared due date and /tasks returns it raw.
    // One such task used to fail the entire list; it must decode as "no date".
    func testACleredDueDateDecodesAsNilRatherThanFailingTheList() throws {
        let response = try ProtocolDecoder.json.decode(TasksListResponse.self, from: fixture("tasks-list"))
        XCTAssertEqual(response.tasks.count, 5)
        let cleared = try XCTUnwrap(response.tasks.first { $0.title == "Call the accountant back" })
        XCTAssertNil(cleared.dueDate)
    }

    // An optional date that is present but malformed is the same situation:
    // no usable date, not a reason to drop every other task on the screen.
    func testAMalformedOptionalDateDoesNotFailTheSummary() throws {
        let raw = String(decoding: try fixture("summary-populated"), as: UTF8.self)
            .replacingOccurrences(of: "\"2020-04-15\"", with: "\"not a date\"")
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: Data(raw.utf8))
        XCTAssertEqual(summary.today.count, 3)
        XCTAssertNil(summary.today.first { $0.title == "File the quarterly taxes" }?.dueDate)
    }

    // A daemon that grows a field (this fixture doesn't carry `sourceMeta`
    // as a modelled property at all) must not brick every installed phone.
    func testUnknownFieldsDoNotBreakDecoding() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("tasks-list")) as? [String: Any])
        var tasks = try XCTUnwrap(object["tasks"] as? [[String: Any]])
        tasks[0]["somethingNew"] = ["nested": true]
        object["tasks"] = tasks
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertNoThrow(try ProtocolDecoder.json.decode(TasksListResponse.self, from: data))
    }

    func testTaskBucketCoversEveryValueTheProtocolEnumerates() {
        // mobile/PROTOCOL.md §5: "today | this_week | this_month |
        // this_quarter | this_year | someday | done".
        let wireValues = Set(TaskBucket.allCases.map(\.rawValue))
        XCTAssertEqual(wireValues, ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"])
    }

    func testTaskStatusCoversEveryValueTheProtocolEnumerates() {
        let wireValues = Set(TaskStatusValue.allCases.map(\.rawValue))
        XCTAssertEqual(wireValues, ["pending", "in_progress", "blocked", "completed", "cancelled"])
    }
}
