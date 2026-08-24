import Foundation
import XCTest
@testable import OpenAGI

final class PendingApprovalTests: XCTestCase {
  func testPendingApprovalDecodesDurableQueueFields() throws {
    let data = Data(#"""
    {
      "id":"act_123",
      "toolName":"start_computer_use_session",
      "summary":"Open a computer-use session",
      "status":"pending",
      "createdAt":"2026-08-14T12:00:00.000Z",
      "args":{"goal":"ignored by the compact approval card"}
    }
    """#.utf8)

    let item = try JSONDecoder().decode(PendingApproval.self, from: data)
    XCTAssertEqual(item.id, "act_123")
    XCTAssertEqual(item.toolName, "start_computer_use_session")
    XCTAssertEqual(item.summary, "Open a computer-use session")
    XCTAssertEqual(item.status, "pending")
  }

  func testPendingApprovalUsesReadableDefaultsForOlderServers() throws {
    let item = try JSONDecoder().decode(
      PendingApproval.self,
      from: Data(#"{"id":"act_old"}"#.utf8))

    XCTAssertEqual(item.toolName, "agent_action")
    XCTAssertEqual(item.summary, "Agent action needs approval")
    XCTAssertEqual(item.status, "pending")
  }

  @MainActor
  func testTerminalApprovalFailureKeepsTheExecutionError() {
    let data = Data(#"{"ok":false,"error":"input permissions changed"}"#.utf8)
    XCTAssertEqual(
      PendingApprovalConsumer.terminalDecisionError(statusCode: 400, data: data),
      "input permissions changed")
    XCTAssertEqual(
      PendingApprovalConsumer.terminalDecisionError(statusCode: 409, data: Data()),
      "This approval is no longer pending.")
    XCTAssertNil(PendingApprovalConsumer.terminalDecisionError(statusCode: 500, data: data))
  }

  @MainActor
  func testComputerUseTerminalEventReconcilesOnlyTheApprovedSession() {
    XCTAssertNil(PendingApprovalConsumer.terminalComputerUseOutcome(
      sessionId: "cus_expected",
      data: #"{"kind":"session-end","session":{"id":"cus_other","status":"ended"}}"#))

    let finished = PendingApprovalConsumer.terminalComputerUseOutcome(
      sessionId: "cus_expected",
      data: #"{"kind":"session-end","session":{"id":"cus_expected","status":"ended"}}"#)
    XCTAssertEqual(finished?.outcome, "Computer task finished. Open Chat for the result.")
    XCTAssertNil(finished?.error)

    let aborted = PendingApprovalConsumer.terminalComputerUseOutcome(
      sessionId: "cus_expected",
      data: #"{"kind":"session-end","session":{"id":"cus_expected","status":"aborted","endReason":"private runtime detail"}}"#)
    XCTAssertNil(aborted?.outcome)
    XCTAssertEqual(aborted?.error, "Computer task stopped. Open Chat for details.")
  }
}
