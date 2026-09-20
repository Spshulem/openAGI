import XCTest
@testable import OpenAGI

final class PendingActionDecodingTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let here = URL(filePath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appending(path: "fixtures/\(name).json"))
    }

    // mobile/PROTOCOL.md §11 claims this fixture "pins the empty-list shape
    // ... because the fixture daemon has nothing pending" -- that's stale:
    // the committed file actually carries one populated `send_email` action.
    // This test follows the real file, not that prose; see the phase report.
    func testDecodesThePopulatedFixture() throws {
        let response = try ProtocolDecoder.json.decode(PendingActionsResponse.self, from: fixture("pending-actions"))
        XCTAssertEqual(response.actions.count, 1)
        let action = try XCTUnwrap(response.actions.first)
        XCTAssertEqual(action.toolName, "send_email")
        XCTAssertEqual(action.status, "pending")
        XCTAssertEqual(action.reason, "Drafted from your Friday routine")
        guard case let .object(args) = try XCTUnwrap(action.args) else { return XCTFail("expected object args") }
        XCTAssertEqual(args["to"], .string("team@example.com"))
    }

    // mobile/PROTOCOL.md §6's live-captured example, verbatim.
    func testDecodesAPopulatedActionWithArbitraryJSONArgs() throws {
        let json = """
        {"actions": [{
          "id": "act_840d87422622443a",
          "toolName": "send_email",
          "args": { "to": "someone@example.com" },
          "context": null,
          "summary": "Send an email to someone@example.com",
          "reason": null,
          "dedupeKey": null,
          "status": "pending",
          "createdAt": "2026-09-20T01:40:25.625Z",
          "expiresAt": null,
          "decidedAt": null,
          "decidedBy": null,
          "result": null,
          "error": null
        }]}
        """
        let response = try ProtocolDecoder.json.decode(PendingActionsResponse.self, from: Data(json.utf8))
        let action = try XCTUnwrap(response.actions.first)
        XCTAssertEqual(action.toolName, "send_email")
        XCTAssertEqual(action.status, "pending")
        guard case let .object(fields) = action.args else { return XCTFail("expected an object") }
        XCTAssertEqual(fields["to"], .string("someone@example.com"))
    }

    // mobile/PROTOCOL.md §6: "{"ok": true, "result": ...}" on success or
    // "{"ok": false, "error": "..."}" on failure -- no single fixed schema
    // beyond the ok/error envelope.
    func testDecodesBothApprovalOutcomeShapes() throws {
        let success = try ProtocolDecoder.json.decode(ApprovalOutcome.self, from: Data(#"{"ok":true,"result":{"sent":true}}"#.utf8))
        XCTAssertTrue(success.ok)
        XCTAssertNil(success.error)

        let failure = try ProtocolDecoder.json.decode(ApprovalOutcome.self, from: Data(#"{"ok":false,"error":"boom"}"#.utf8))
        XCTAssertFalse(failure.ok)
        XCTAssertEqual(failure.error, "boom")
    }

    // mobile/PROTOCOL.md §6's exact deny response shape.
    func testDecodesTheDenyOutcome() throws {
        let outcome = try ProtocolDecoder.json.decode(DenyOutcome.self, from: Data(#"{"id":"act_840d87422622443a","status":"denied"}"#.utf8))
        XCTAssertEqual(outcome.status, "denied")
    }

    func testJSONValueDisplayDescriptionRendersNestedValuesReadably() {
        let value = JSONValue.object(["to": .string("a@b.com"), "cc": .array([.string("x"), .string("y")])])
        let description = value.displayDescription
        XCTAssertTrue(description.contains("a@b.com"))
        XCTAssertTrue(description.contains("[x, y]"))
    }
}
