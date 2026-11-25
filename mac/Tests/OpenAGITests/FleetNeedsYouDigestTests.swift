import SupervisorChannelsKit
import XCTest

/// The shared Needs You contract (SupervisorChannelsKit) used by the Mac
/// workspace and the iPhone Needs You list. Named Fleet* so the Mac CI
/// filter runs it.
final class FleetNeedsYouDigestTests: XCTestCase {
  // MARK: Counting

  func testFYIsAndCompletionsAreNotCountedAsNeedsYou() {
    // Two decisions, one FYI (needsYou false), one card from an older hub
    // without the flag (counts), and two tool approvals.
    let total = SupervisorAttentionCounting.needsYouTotal(
      needsYouFlags: [true, false, nil, true],
      pendingApprovals: 2
    )
    XCTAssertEqual(total, 5)
    XCTAssertFalse(SupervisorAttentionCounting.isActionable(needsYou: false))
    XCTAssertTrue(SupervisorAttentionCounting.isActionable(needsYou: nil))
  }

  func testNegativeApprovalCountNeverLowersTheTotal() {
    XCTAssertEqual(SupervisorAttentionCounting.needsYouTotal(needsYouFlags: [true], pendingApprovals: -3), 1)
  }

  // MARK: Badges

  func testPlainDecisionsCarryNoBadge() {
    XCTAssertNil(SupervisorNeedsYouBadge.make(kind: "agent-ask", risky: false, ciState: nil))
    XCTAssertNil(SupervisorNeedsYouBadge.make(kind: nil, risky: false, ciState: "SUCCESS"))
  }

  func testBadgesOnlySayWhatChangesTheOrderOfWork() {
    XCTAssertEqual(SupervisorNeedsYouBadge.make(kind: "ci_failed", risky: true, ciState: nil),
                   SupervisorNeedsYouBadge(text: "Checks failing", tone: .alert))
    XCTAssertEqual(SupervisorNeedsYouBadge.make(kind: "agent-ask", risky: false, ciState: "failure"),
                   SupervisorNeedsYouBadge(text: "Checks failing", tone: .alert))
    XCTAssertEqual(SupervisorNeedsYouBadge.make(kind: "agent-ask", risky: true, ciState: nil),
                   SupervisorNeedsYouBadge(text: "Risky", tone: .caution))
    XCTAssertEqual(SupervisorNeedsYouBadge.make(kind: "merge_ready", risky: false, ciState: "SUCCESS"),
                   SupervisorNeedsYouBadge(text: "PR ready", tone: .neutral))
  }

  // MARK: Digest

  func testSectionsKeepGoalStateBlockerDecisionEvidenceOrder() {
    let digest = SupervisorNeedsYouDigest(
      headline: "Pick the migration window",
      goal: "Move the billing tables to the new cluster",
      state: "Dry run finished; 0 rows differ",
      blocker: "Production writes must pause, and only you can schedule that",
      decision: "Tonight at 22:00, or Saturday morning?",
      recommendation: "Saturday: lower traffic",
      evidence: ["Dry-run log: 412k rows copied in 6m", "PR #12"]
    )
    XCTAssertEqual(digest.sections.map(\.kind), [.goal, .state, .blocker, .decision, .recommendation, .evidence, .evidence])
    XCTAssertEqual(digest.reason, "Production writes must pause, and only you can schedule that")
    XCTAssertEqual(digest.sections(.evidence).count, 2)
  }

  func testRepeatedTextIsShownOnce() {
    // The old cards repeated the headline as the fact and the decision, and
    // the brief's decision again as the agent context.
    let digest = SupervisorNeedsYouDigest(
      headline: "Which branch should the release use?",
      goal: "  ",
      state: nil,
      blocker: "which branch should the release use",
      decision: "Which branch should the release use?",
      recommendation: "Use release/2.4. It has the hotfix.",
      evidence: ["Use release/2.4. It has the hotfix.", "release/2.4"]
    )
    XCTAssertEqual(digest.sections.map(\.kind), [.recommendation, .evidence])
    XCTAssertEqual(digest.sections.last?.text, "release/2.4")
    // Nothing says more than the title: no reason line under it.
    XCTAssertNil(digest.reason)
  }

  func testReasonFallsBackToDecisionThenState() {
    XCTAssertEqual(SupervisorNeedsYouDigest(headline: "A", decision: "Merge now or wait for review?").reason,
                   "Merge now or wait for review?")
    XCTAssertEqual(SupervisorNeedsYouDigest(headline: "A", state: "CI green, 2 approvals").reason,
                   "CI green, 2 approvals")
  }

  func testReasonIsOnePlainLineCutAtAWord() throws {
    let long = "**Blocked:** " + String(repeating: "the deploy needs a production credential rotation ", count: 6)
    let digest = SupervisorNeedsYouDigest(headline: "Rotate credentials", blocker: "\n\n" + long + "\nsecond line")
    let reason = try XCTUnwrap(digest.reason)
    XCTAssertTrue(reason.hasPrefix("Blocked: the deploy"))
    XCTAssertFalse(reason.contains("\n"))
    XCTAssertFalse(reason.contains("**"))
    XCTAssertTrue(reason.hasSuffix("…"))
    XCTAssertLessThanOrEqual(reason.count, SupervisorNeedsYouDigest.reasonLimit + 1)
  }

  func testAReasonSharedByManyRowsGivesWayToEachRowsOwnSpecifics() {
    let generic = "The agent is waiting for your answer before it can continue."
    let digests = [
      SupervisorNeedsYouDigest(headline: "Region?", blocker: generic, decision: "us-east-2 or eu-west-1?"),
      SupervisorNeedsYouDigest(headline: "Refunds?", blocker: generic, decision: "Prorate or credit only?"),
      SupervisorNeedsYouDigest(headline: "Name?", blocker: generic),
      SupervisorNeedsYouDigest(headline: "Deploy?", blocker: "Merging deploys to production.")
    ]
    XCTAssertEqual(SupervisorNeedsYouDigest.rowReasons(for: digests), [
      "us-east-2 or eu-west-1?",
      "Prorate or credit only?",
      generic, // nothing more specific to say
      "Merging deploys to production."
    ])
    // Two rows alone keep their reasons as they are.
    XCTAssertEqual(SupervisorNeedsYouDigest.rowReasons(for: Array(digests.prefix(2))), [generic, generic])
  }

  func testEmptyHeadlineGetsAPlainTitle() {
    XCTAssertEqual(SupervisorNeedsYouDigest(headline: "  \n").title, "Needs your decision")
  }
}
