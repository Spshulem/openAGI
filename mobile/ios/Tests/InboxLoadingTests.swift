import XCTest
@testable import OpenAGI

// Pins the fix for the bug the task report found by actually opening the
// app: `GET /tasks/:id` swallowed the literal `/tasks/clarifications` route
// (a daemon bug, fixed separately, with its own regression test), so every
// clarifications fetch 404'd. `InboxView.load()` used to await both
// endpoints as one `(actions, clars)` tuple, so that single 404 threw before
// either `@State` array was assigned -- the whole Inbox screen showed only
// the error string, even though pending actions would have loaded fine.
// These tests pin the fix at the pure-logic level: one endpoint failing must
// never blank out the other's result.
final class InboxLoadingTests: XCTestCase {
    private func pendingAction(id: String = "act_1") throws -> PendingAction {
        let json = """
        {"id":"\(id)","toolName":"send_email","args":null,"context":null,
         "summary":"Send the weekly digest","reason":null,"dedupeKey":null,
         "status":"pending","createdAt":"2026-09-20T01:00:00.000Z",
         "expiresAt":null,"decidedAt":null,"decidedBy":null,"result":null,"error":null}
        """
        return try ProtocolDecoder.json.decode(PendingAction.self, from: Data(json.utf8))
    }

    private func clarification(id: String = "clar_1") throws -> Clarification {
        let json = """
        {"id":"\(id)","taskId":"task_1","question":"Ship it today or tomorrow?",
         "context":"","proposedAction":"","confidence":null,"sources":[],
         "status":"pending","answer":null,"answeredAt":null,
         "createdAt":"2026-09-20T01:00:00.000Z"}
        """
        return try ProtocolDecoder.json.decode(Clarification.self, from: Data(json.utf8))
    }

    // The exact regression: clarifications 404s, pending actions succeed.
    // Approvals must still populate; only the Clarifications section reports
    // an error.
    func testAFailedClarificationsFetchLeavesPendingActionsPopulated() throws {
        let action = try pendingAction()
        let result = InboxLoader.combine(
            pendingActions: .success([action]),
            clarifications: .failure(DaemonError.notFound)
        )
        XCTAssertEqual(result.pendingActions, [action])
        XCTAssertNil(result.pendingActionsError)
        XCTAssertTrue(result.clarifications.isEmpty)
        XCTAssertEqual(result.clarificationsError, "This item is gone — someone else may have already decided it.")
    }

    // The mirror case: pending actions fail, clarifications succeed.
    func testAFailedPendingActionsFetchLeavesClarificationsPopulated() throws {
        let clarification = try clarification()
        let result = InboxLoader.combine(
            pendingActions: .failure(DaemonError.unauthorized),
            clarifications: .success([clarification])
        )
        XCTAssertTrue(result.pendingActions.isEmpty)
        XCTAssertEqual(result.pendingActionsError, "Needs re-pairing — revoke and pair again in Settings.")
        XCTAssertEqual(result.clarifications, [clarification])
        XCTAssertNil(result.clarificationsError)
    }

    func testBothSucceedingPopulatesBothWithNoErrors() throws {
        let action = try pendingAction()
        let clarification = try clarification()
        let result = InboxLoader.combine(pendingActions: .success([action]), clarifications: .success([clarification]))
        XCTAssertEqual(result.pendingActions, [action])
        XCTAssertEqual(result.clarifications, [clarification])
        XCTAssertNil(result.pendingActionsError)
        XCTAssertNil(result.clarificationsError)
    }

    func testBothFailingReportsBothErrorsWithNeitherListPopulated() {
        let result = InboxLoader.combine(pendingActions: .failure(DaemonError.server(500)),
                                          clarifications: .failure(DaemonError.server(500)))
        XCTAssertTrue(result.pendingActions.isEmpty)
        XCTAssertTrue(result.clarifications.isEmpty)
        XCTAssertEqual(result.pendingActionsError, "Can't reach OpenAGI.")
        XCTAssertEqual(result.clarificationsError, "Can't reach OpenAGI.")
    }

    // A non-`DaemonError` (e.g. a raw `URLError` some other path could throw)
    // must still produce readable copy rather than crashing the mapper.
    func testANonDaemonErrorFallsBackToTheGenericUnreachableCopy() {
        struct SomeOtherError: Error {}
        let result = InboxLoader.combine(pendingActions: .failure(SomeOtherError()), clarifications: .success([]))
        XCTAssertEqual(result.pendingActionsError, "Can't reach OpenAGI.")
    }
}
