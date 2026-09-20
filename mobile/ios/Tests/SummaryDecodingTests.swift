import XCTest
@testable import OpenAGI

final class SummaryDecodingTests: XCTestCase {
    // The fixtures are generated from a running daemon by
    // scripts/generate-mobile-fixtures.mjs. Decoding them here is what stops
    // this client from drifting away from the server it talks to.
    private func fixture(_ name: String) throws -> Data {
        let here = URL(filePath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appending(path: "fixtures/\(name).json"))
    }

    func testDecodesPopulatedSummary() throws {
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-populated"))
        XCTAssertEqual(summary.today.count, 2)
        XCTAssertEqual(summary.today.first?.title, "Ship the widget")
        XCTAssertEqual(summary.counts.today, 2)
        XCTAssertEqual(summary.counts.overdue, 1)
        XCTAssertTrue(summary.today.contains { $0.overdue })
        XCTAssertFalse(summary.brief.headline.isEmpty)
        XCTAssertEqual(summary.pendingActions.count, 1)
        XCTAssertTrue(!summary.pendingActions[0].id.isEmpty && !summary.pendingActions[0].summary.isEmpty && summary.pendingActions[0].createdAt != nil)
    }

    func testDecodesEmptySummary() throws {
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-empty"))
        XCTAssertTrue(summary.today.isEmpty)
        XCTAssertEqual(summary.counts.pendingActions, 0)
    }

    func testDatesDecodeAsRealDates() throws {
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-populated"))
        XCTAssertTrue(summary.generatedAt.timeIntervalSince1970 > 1_600_000_000)
        let overdue = try XCTUnwrap(summary.today.first { $0.overdue })
        XCTAssertNotNil(overdue.dueDate)
    }

    func testUnknownFieldsDoNotBreakDecoding() throws {
        // A daemon that grows a field must not brick every installed phone.
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try fixture("summary-populated")) as? [String: Any]
        )
        object["somethingNew"] = ["nested": true]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertNoThrow(try ProtocolDecoder.json.decode(MobileSummary.self, from: data))
    }

    func testPairingURLParses() throws {
        let payload = try XCTUnwrap(
            PairingPayload(url: URL(string: "openagi://pair?url=http://mac.ts.net:43210&code=004221&platform=ios")!)
        )
        XCTAssertEqual(payload.serverURL.absoluteString, "http://mac.ts.net:43210")
        XCTAssertEqual(payload.code, "004221")
    }
}
