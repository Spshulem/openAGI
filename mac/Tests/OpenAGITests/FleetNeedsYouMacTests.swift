import SupervisorChannelsKit
import XCTest
@testable import OpenAGI

/// The Mac side of Needs You: decoding the hub's card brief next to its
/// questions, the count the sidebar and Dock show, and the digest each row
/// and the inspector are built from. Uses the synthetic review fixture.
@MainActor
final class FleetNeedsYouMacTests: XCTestCase {
  private func fixtureState() throws -> FleetState {
    try JSONDecoder().decode(FleetState.self, from: Data(NeedsYouFixture.stateJSON.utf8))
  }

  func testFixtureCountsOnlyActionableDecisions() throws {
    let state = try fixtureState()
    XCTAssertEqual(state.questions.count, 15, "12 decisions and 3 FYIs/completions")
    // The old sidebar count was questions.count + approvals: 15 + 2 here,
    // while the list showed 12 rows and the 2 approvals.
    XCTAssertEqual(SupervisorAttentionCounting.needsYouTotal(needsYouFlags: state.questions.map(\.needsYou), pendingApprovals: 2), 14)
  }

  func testCardBriefsDecodeAndKeyByQuestion() throws {
    let state = try fixtureState()
    XCTAssertEqual(state.cards.count, 15)
    let deploy = try XCTUnwrap(state.cards.first { $0.questionKey == "ny-deploy" })
    XCTAssertTrue(deploy.context?.hasPrefix("Ship the redesigned checkout") == true)
    XCTAssertEqual(deploy.ciState, "SUCCESS")
    XCTAssertFalse(try XCTUnwrap(state.cards.first { $0.questionKey == "fyi-docs" }).needsYou)
  }

  func testCardBriefDecodingIsLenient() throws {
    let state = try JSONDecoder().decode(FleetState.self, from: Data("""
      {"questions":[{"id":"q1","title":"Ship?"}],
       "cards":[{"id":"q1","brief":"not an object","recommendation":7},{"title":"no id, dropped"}]}
      """.utf8))
    XCTAssertEqual(state.cards.map(\.id), ["q1"])
    XCTAssertNil(state.cards[0].context)
    XCTAssertNil(state.cards[0].recommendation)
    XCTAssertTrue(state.cards[0].needsYou)
  }

  func testOlderHubWithoutCardsStillDecodes() throws {
    let state = try JSONDecoder().decode(FleetState.self, from: Data(#"{"questions":[{"id":"q1","title":"Ship?"}]}"#.utf8))
    XCTAssertTrue(state.cards.isEmpty)
    XCTAssertEqual(state.questions.count, 1)
  }

  func testDecisionDigestOrdersContextBeforeTheAsk() throws {
    let state = try fixtureState()
    let q = try XCTUnwrap(state.questions.first { $0.id == "ny-deploy" })
    let card = state.cards.first { $0.questionKey == q.id }
    let digest = q.needsYouDigest(card: card)
    XCTAssertEqual(digest.title, "Merge PR #412 and deploy the checkout redesign to production?")
    XCTAssertEqual(Array(digest.sections.map(\.kind).prefix(5)), [.goal, .state, .blocker, .decision, .recommendation])
    XCTAssertEqual(digest.reason, "Merging deploys to production. Only you can approve a production deploy.")
    XCTAssertTrue(digest.sections(.evidence).contains { $0.text == "Pull request acme/atlas#412" })
    XCTAssertEqual(q.needsYouBadge(card: card), SupervisorNeedsYouBadge(text: "Risky", tone: .caution))
  }

  func testClarificationPutsTheQuestionAsTheDecision() throws {
    let state = try fixtureState()
    let q = try XCTUnwrap(state.questions.first { $0.id == "ny-net30" })
    XCTAssertTrue(q.isClarificationQuestion)
    let digest = q.needsYouDigest(card: state.cards.first { $0.questionKey == q.id })
    XCTAssertTrue(digest.sections(.decision).first?.text.hasPrefix("Answer which date") == true)
    XCTAssertTrue(digest.sections(.recommendation).isEmpty)
  }

  func testWithoutACardTheQuestionAloneStillGivesWhyAndDecision() throws {
    let q = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"q9","kind":"agent-ask","title":"Which branch?","body":"main or release/2.4?",
       "decisionFact":"The release branch is ambiguous.","askContext":"I can use either branch."}
      """.utf8))
    let digest = q.needsYouDigest(card: nil)
    XCTAssertEqual(digest.sections.map(\.kind), [.blocker, .decision, .evidence])
    XCTAssertNil(q.needsYouBadge(card: nil), "a plain decision carries no badge")
  }

  func testCurrentStateLeadsAndWhatChangedBecomesEvidence() throws {
    let state = try JSONDecoder().decode(FleetState.self, from: Data("""
      {"questions":[{"id":"q1","kind":"agent-ask","title":"Ship it?","decisionFact":"Production needs you."}],
       "cards":[{"id":"q1","brief":{"context":"Ship checkout","currentState":"Green and staged.",
                 "whatChanged":"Rebased on main; 3 visual changes.","decision":"Ship now or Monday?"}}]}
      """.utf8))
    let card = try XCTUnwrap(state.cards.first)
    XCTAssertEqual(card.currentState, "Green and staged.")
    let digest = state.questions[0].needsYouDigest(card: card)
    XCTAssertEqual(digest.sections(.state).first?.text, "Green and staged.")
    XCTAssertEqual(digest.sections(.evidence).first?.text, "Rebased on main; 3 visual changes.")
    // Without a current state, what changed is where it stands.
    let older = FleetCardBrief(id: "q1", whatChanged: "Rebased on main.")
    XCTAssertEqual(state.questions[0].needsYouDigest(card: older).sections(.state).first?.text, "Rebased on main.")
  }

  func testDockMenuAndBadgeCountOnlyActionableDecisions() throws {
    FleetConsumer.shared.apply(try fixtureState())
    // Leave the shared consumer as other tests expect it: no supervisor.
    defer { FleetConsumer.shared.apply(try! JSONDecoder().decode(FleetState.self, from: Data("{}".utf8))) }
    XCTAssertEqual(AppDelegate.needsYouWaitingCount, 12 + PendingApprovalConsumer.shared.items.count)
  }

  func testAThreadlessClarificationCanStillBeAnsweredInTheInspector() throws {
    let state = try fixtureState()
    let clarification = try XCTUnwrap(state.questions.first { $0.id == "ny-net30" })
    XCTAssertTrue(clarification.isClarificationQuestion)
    let threadless = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"s1","kind":"suggestion","title":"Clarify","options":["Answer question"],"canReply":false}
      """.utf8))
    XCTAssertNil(threadless.threadKey)
    XCTAssertTrue(SupervisorThreadInspectorView.acceptsReply(threadless))
    let fyi = try JSONDecoder().decode(FleetQuestion.self, from: Data(#"{"id":"f1","kind":"completed","canReply":false}"#.utf8))
    XCTAssertFalse(SupervisorThreadInspectorView.acceptsReply(fyi))
  }
}
