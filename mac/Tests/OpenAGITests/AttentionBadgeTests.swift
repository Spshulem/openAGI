import Foundation
import XCTest
#if !ATTENTION_BADGE_STANDALONE
@testable import OpenAGI
#endif

final class AttentionBadgeTests: XCTestCase {
  private let now = ISO8601DateFormatter().date(from: "2026-01-15T12:00:00Z")!

  private func item(
    id: String = "notice", type: String = "suggestion", status: String = "unseen",
    decision: Bool = false, date: String? = "2026-01-15T10:00:00.000Z",
    source: [String: String]? = nil
  ) throws -> OutreachItem {
    var json: [String: Any] = ["id": id, "type": type, "status": status, "needsDecision": decision]
    if let date { json["createdAt"] = date }
    if let source { json["sourceRef"] = source }
    return try JSONDecoder().decode(OutreachItem.self, from: JSONSerialization.data(withJSONObject: json))
  }

  func testHistoricalNotificationsDoNotBecomeTasks() throws {
    let history = try (0..<15_052).map { try item(id: "notice-\($0)", type: $0 % 2 == 0 ? "digest" : "skill", date: nil) }
    XCTAssertEqual(AttentionBadge.count(briefKeys: [], outreach: history, approvalIDs: [], fleetIDs: [], now: now), 0)
    XCTAssertEqual(history.count, 15_052, "presentation must not delete notification history")
  }

  func testRecentDecisionsCountButInformationAndResolvedItemsDoNot() throws {
    for status in ["unseen", "seen", "error"] {
      XCTAssertTrue(AttentionBadge.needsAttention(try item(status: status, decision: true), now: now))
    }
    for status in ["acted", "dismissed", "unknown"] {
      XCTAssertFalse(AttentionBadge.needsAttention(try item(status: status, decision: true), now: now))
    }
    XCTAssertFalse(AttentionBadge.needsAttention(try item(), now: now))
    XCTAssertFalse(AttentionBadge.needsAttention(try item(type: "digest", decision: true), now: now))
    XCTAssertFalse(AttentionBadge.needsAttention(try item(type: "pending-action", decision: true), now: now))
  }

  func testOldMissingMalformedAndFutureDecisionDatesDoNotAccumulate() throws {
    for date in [nil, "invalid", "2026-01-01T12:00:00Z", "2026-02-01T12:00:00Z"] as [String?] {
      XCTAssertFalse(AttentionBadge.needsAttention(try item(decision: true, date: date), now: now))
    }
    XCTAssertTrue(AttentionBadge.needsAttention(try item(decision: true, date: "2026-01-08T12:00:00Z"), now: now))
    XCTAssertFalse(AttentionBadge.needsAttention(try item(decision: true, date: "2026-01-08T11:59:59Z"), now: now))
  }

  func testApprovalsAndCurrentQueuesNeverExpire() throws {
    let approval = try item(type: "coding-approval", decision: true, date: nil)
    XCTAssertTrue(AttentionBadge.needsAttention(approval, now: now))
    XCTAssertEqual(AttentionBadge.count(briefKeys: ["task:one"], outreach: [approval], approvalIDs: ["old"], fleetIDs: ["question"], now: now), 4)
    XCTAssertFalse(AttentionBadge.needsAttention(try item(type: "coding-approval", status: "acted", decision: true, date: nil), now: now))
  }

  func testSourceReferencesAreCountedOnceAcrossSurfaces() throws {
    let notices = try [
      item(id: "first", decision: true, source: ["kind": "clarification", "id": "one"]),
      item(id: "duplicate", decision: true, source: ["kind": "clarification", "id": "one"]),
      item(id: "fleet-copy", type: "fleet-question", decision: true, source: ["kind": "fleet", "id": "question"]),
      item(id: "approval-copy", type: "coding-approval", decision: true, source: ["kind": "pending-action", "id": "approval"])
    ]
    XCTAssertEqual(AttentionBadge.count(briefKeys: ["clarification:one"], outreach: notices, approvalIDs: ["approval"], fleetIDs: ["question"], now: now), 3)
  }

  func testLargeCountsStayCompact() {
    XCTAssertEqual(AttentionBadge.label(0), "0")
    XCTAssertEqual(AttentionBadge.label(99), "99")
    XCTAssertEqual(AttentionBadge.label(100), "99+")
    XCTAssertEqual(AttentionBadge.label(15_052), "99+")
  }
}

#if ATTENTION_BADGE_STANDALONE
@main
struct AttentionBadgeTestRunner {
  static func main() {
    let suite = AttentionBadgeTests.defaultTestSuite
    suite.run()
    guard let run = suite.testRun, run.executionCount == 6, run.hasSucceeded else { exit(1) }
  }
}
#endif
