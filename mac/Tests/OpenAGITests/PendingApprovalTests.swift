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
}
