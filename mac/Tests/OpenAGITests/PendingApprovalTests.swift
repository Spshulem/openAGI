import Foundation
import XCTest
@testable import OpenAGI

final class PendingApprovalTests: XCTestCase {
  @MainActor
  func testCodingAttentionNotifiesAndReviewsWithoutInlineExecution() {
    XCTAssertTrue(NotificationPresenter.shouldNotify(type: "coding-agent", needsDecision: false, quiet: false))
    XCTAssertFalse(NotificationPresenter.shouldNotify(type: "coding-agent", needsDecision: false, quiet: true))
    XCTAssertFalse(NotificationPresenter.shouldNotify(type: "suggestion", needsDecision: false, quiet: false))
    XCTAssertEqual(NotificationPresenter.reviewPath(type: "coding-agent"), "/?tab=coding-agents")
    XCTAssertEqual(NotificationPresenter.reviewPath(type: "coding-approval"), "/?tab=approvals")
  }
  func testCodingApprovalKeepsCompleteInstructionForReview() throws {
    let instruction = String(repeating: "Reviewable instruction. ", count: 150) + "IMPORTANT FINAL SENTENCE"
    let data = try JSONSerialization.data(withJSONObject: [
      "id": "fixture-approval", "toolName": "reply_to_coding_agent", "status": "pending",
      "summary": "Short summary", "args": [
        "provider": "codex", "sessionId": "fixture-session", "project": "Fixture", "message": instruction
      ]
    ])
    let item = try JSONDecoder().decode(PendingApproval.self, from: data)
    XCTAssertEqual(item.codingReply?.message, instruction)
    XCTAssertTrue(item.codingReply?.text.contains("IMPORTANT FINAL SENTENCE") == true)
    XCTAssertTrue(item.codingReply?.text.contains("separate decision") == true)
  }

  func testPendingApprovalDecodesDurableQueueFields() throws {
    let data = Data(#"""
    {
      "id":"act_123",
      "toolName":"start_computer_use_session",
      "summary":"Open a computer-use session",
      "status":"pending",
      "createdAt":"2026-08-14T12:00:00.000Z",
      "context":{"sessionId":"overlay:user:main"},
      "args":{"goal":"ignored by the compact approval card"}
    }
    """#.utf8)

    let item = try JSONDecoder().decode(PendingApproval.self, from: data)
    XCTAssertEqual(item.id, "act_123")
    XCTAssertEqual(item.toolName, "start_computer_use_session")
    XCTAssertEqual(item.summary, "Open a computer-use session")
    XCTAssertEqual(item.status, "pending")
    XCTAssertEqual(item.sourceSessionId, "overlay:user:main")
  }

  func testPendingApprovalUsesReadableDefaultsForOlderServers() throws {
    let item = try JSONDecoder().decode(
      PendingApproval.self,
      from: Data(#"{"id":"act_old"}"#.utf8))

    XCTAssertEqual(item.toolName, "agent_action")
    XCTAssertEqual(item.summary, "Agent action needs approval")
    XCTAssertEqual(item.status, "pending")
    XCTAssertNil(item.sourceSessionId)
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
      data: #"{"kind":"session-end","session":{"id":"cus_expected","status":"ended","sourceSessionId":"overlay:user:main"}}"#)
    XCTAssertEqual(finished?.outcome, "Computer task finished.")
    XCTAssertNil(finished?.error)
    XCTAssertEqual(finished?.chatSessionId, "overlay:user:main")

    let aborted = PendingApprovalConsumer.terminalComputerUseOutcome(
      sessionId: "cus_expected",
      data: #"{"kind":"session-end","session":{"id":"cus_expected","status":"aborted","endReason":"private runtime detail"}}"#)
    XCTAssertNil(aborted?.outcome)
    XCTAssertEqual(aborted?.error, "Computer task stopped.")
    XCTAssertNil(aborted?.chatSessionId)
  }

  @MainActor
  func testOnlyComputerUseApprovalsOwnComputerSessionTracking() {
    XCTAssertTrue(PendingApprovalConsumer.isComputerUseApproval("start_computer_use_session"))
    XCTAssertFalse(PendingApprovalConsumer.isComputerUseApproval("send_message"))
    XCTAssertFalse(PendingApprovalConsumer.isComputerUseApproval(nil))
  }

  @MainActor
  func testDismissingOutcomeKeepsRunningSessionReconciliation() {
    let consumer = PendingApprovalConsumer()
    consumer.trackComputerSession("cus_running", chatSessionId: "overlay:user:main")

    consumer.clearOutcome()
    XCTAssertNil(consumer.lastOutcome)
    XCTAssertNil(consumer.lastChatSessionId)

    consumer.handleComputerUseEvent(
      #"{"kind":"session-end","session":{"id":"cus_running","status":"ended","sourceSessionId":"overlay:user:main"}}"#)
    XCTAssertEqual(consumer.lastOutcome, "Computer task finished.")
    XCTAssertEqual(consumer.lastChatSessionId, "overlay:user:main")
  }
}
