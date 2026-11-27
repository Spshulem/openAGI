import XCTest
@testable import OpenAGI

/// The four-part Needs You decision (Goal, Status, Decision, Recommendation):
/// decoding the hub's `decisionView` and action flags, and the buttons and
/// quick replies a card shows. Uses FleetDecisionViewFixture.
@MainActor
final class FleetDecisionViewTests: XCTestCase {
  private func cards() throws -> [FleetCardBrief] {
    try JSONDecoder().decode([FleetCardBrief].self, from: Data(FleetDecisionViewFixture.cardsJSON.utf8))
  }

  private func state() throws -> FleetState {
    try JSONDecoder().decode(FleetState.self, from: Data(FleetDecisionViewFixture.stateJSON.utf8))
  }

  private func card(_ id: String) throws -> FleetCardBrief {
    try XCTUnwrap(try state().cards.first { $0.questionKey == id })
  }

  private func question(_ id: String) throws -> FleetQuestion {
    try XCTUnwrap(try state().questions.first { $0.id == id })
  }

  // MARK: Decoding

  func testRegressionCardDecodesAllFourParts() throws {
    let card = try XCTUnwrap(try cards().first { $0.id == "fq_regression" })
    let view = try XCTUnwrap(card.decisionView)
    XCTAssertEqual(view.version, 1)
    XCTAssertEqual(view.goal.title, "Sales v1 PR review")
    XCTAssertEqual(view.goal.text, "Finish the remaining Sales call-type admission work.")
    XCTAssertFalse(view.goal.unknown)
    XCTAssertEqual(view.status.done, ["GitHub shows no other failing checks on either."])
    // Each PR's table row is shown once, as its facts, not also as a blocker.
    XCTAssertEqual(view.status.blocked, ["Merging needs your approval because you review every merge."])
    XCTAssertEqual(view.status.unverified, ["The post-merge verification on main is still pending."])
    XCTAssertEqual(view.status.prs.map(\.ref), ["#1201", "#1202"])
    XCTAssertEqual(view.status.prs[1].facts, ["Certificate: passed", "Conflicts: none", "Threads: 5/5 resolved", "Blocker: 1 approving review"])
    XCTAssertEqual(view.decision.options.map(\.value), ["merge both", "wait for teammate review"])
    XCTAssertTrue(view.decision.options[0].adminBypass)
    XCTAssertFalse(view.decision.options[0].recommended)
    XCTAssertTrue(view.decision.options[1].recommended)
    XCTAssertNil(view.decision.options[1].consequence)
    XCTAssertEqual(view.recommendation.option, "wait for teammate review")
    XCTAssertEqual(view.recommendation.why, "Wait for teammate review on both PRs, then merge.")
    XCTAssertTrue(view.unknowns.isEmpty)
    XCTAssertTrue(view.evidence.isEmpty)

    XCTAssertEqual(card.primaryAction?.value, "wait for teammate review")
    XCTAssertTrue(card.primaryAction?.recommended == true)
    XCTAssertTrue(card.secondaryAction?.adminBypass == true)
    XCTAssertEqual(card.secondaryAction?.label, "Merge both (admin bypass)")
    XCTAssertEqual(card.extraActions.map(\.op), ["defer"])
    XCTAssertEqual(card.suggestedReplies, [])
  }

  func testSparseCardDecodesEveryPartAsUnknown() throws {
    let view = try XCTUnwrap(try cards().first { $0.id == "fq_sparse" }?.decisionView)
    XCTAssertTrue(view.goal.unknown)
    XCTAssertNil(view.goal.text)
    XCTAssertTrue(view.status.unknown)
    XCTAssertTrue(view.status.isEmpty)
    XCTAssertTrue(view.decision.unknown)
    XCTAssertTrue(view.decision.options.isEmpty)
    XCTAssertTrue(view.recommendation.unknown)
    XCTAssertEqual(view.unknowns.count, 5)
    XCTAssertEqual(view.unknowns.first, "Goal: not stated in the source")
  }

  func testCardWithoutDecisionViewDecodesAsBefore() throws {
    // The older card with its decisionView removed, as a hub before it sends.
    var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(FleetDecisionViewFixture.cardsJSON.utf8)) as? [[String: Any]])
    raw[2].removeValue(forKey: "decisionView")
    let card = try JSONDecoder().decode(FleetCardBrief.self, from: JSONSerialization.data(withJSONObject: raw[2]))
    XCTAssertNil(card.decisionView)
    XCTAssertEqual(card.context, "Ship the release notes fix")
    XCTAssertEqual(card.decision, "Should I merge #77 over the required review with your admin rights, or wait for review?")
    XCTAssertTrue(card.secondaryAction?.adminBypass == true)
    // The hub drops "proceed with the recommended option" when none is
    // recommended, and a blanket "Approved" next to an admin bypass.
    XCTAssertEqual(card.suggestedReplies.count, 1)
    // No decisionView: today's rendering, not the four parts.
    XCTAssertNil(FleetDecisionPresentation.make(question: nil, card: card))

    let legacy = try self.card("fq_legacy")
    XCTAssertNil(legacy.decisionView)
    XCTAssertNil(try question("fq_legacy").decisionPresentation(card: legacy))
  }

  func testDecisionViewDecodingIsLenient() throws {
    let card = try JSONDecoder().decode(FleetCardBrief.self, from: Data("""
      {"id":"q1","decisionView":{"goal":"not an object","status":{"done":["ok",7,""],"prs":[{"title":"no ref"},{"ref":"#5"}]},
       "decision":{"options":[{"label":"Ship"},{"consequence":"no value or label"},{"value":"hold","recommended":"yes"}]},
       "evidence":[{"label":"CI","url":"https://ci.example/1"},{"label":"no url"},{"label":"local","url":"file:///etc/hosts"}]},
       "primaryAction":{"op":"answer","value":"ship","recommended":"true"},"extraActions":[{"op":"defer"},5],"suggestedReplies":["a",3]}
      """.utf8))
    let view = try XCTUnwrap(card.decisionView)
    XCTAssertTrue(view.goal.unknown)
    XCTAssertEqual(view.status.done, ["ok"])
    XCTAssertFalse(view.status.unknown)
    XCTAssertEqual(view.status.prs.map(\.ref), ["#5"])
    XCTAssertEqual(view.decision.options.map(\.value), ["Ship", "hold"])
    XCTAssertFalse(view.decision.options[1].recommended)
    XCTAssertTrue(view.recommendation.unknown)
    XCTAssertEqual(view.evidence.map(\.label), ["CI", "local"])
    XCTAssertEqual(FleetDecisionPresentation.make(question: nil, card: card)?.evidence.map(\.label), ["CI"], "only web links open")
    XCTAssertFalse(card.primaryAction?.recommended ?? true)
    XCTAssertEqual(card.extraActions.count, 1)
    XCTAssertEqual(card.suggestedReplies, ["a"])

    // A decisionView this build cannot read at all costs only the view.
    let broken = try JSONDecoder().decode(FleetCardBrief.self, from: Data("""
      {"id":"q2","decisionView":"v2-string","brief":{"decision":"Ship?"}}
      """.utf8))
    XCTAssertNil(broken.decisionView)
    XCTAssertEqual(broken.decision, "Ship?")
  }

  func testStateKeysDecisionCardsByQuestion() throws {
    let state = try state()
    XCTAssertEqual(state.questions.map(\.id), ["fq_regression", "fq_sparse", "fq_old", "fq_legacy"])
    XCTAssertEqual(Set(state.cards.map(\.questionKey)), Set(state.questions.map(\.id)))
  }

  // MARK: Buttons and quick replies

  func testRegressionButtonsPutTheRecommendationFirstAndLabelTheBypass() throws {
    let p = try XCTUnwrap(try question("fq_regression").decisionPresentation(card: try card("fq_regression")))
    XCTAssertEqual(p.buttons.map(\.label), ["Wait for teammate review", "Merge both"])
    XCTAssertEqual(p.buttons.map(\.adminBypass), [false, true], "the bypass is labelled by its caption")
    XCTAssertEqual(p.buttons.map(\.value), ["wait for teammate review", "merge both"], "the question's own option strings")
    XCTAssertEqual(p.buttons.map(\.recommended), [true, false])
    XCTAssertEqual(p.buttons.map(\.adminBypass), [false, true])
    // "Later" is the row's own Dismiss, not another option button.
    XCTAssertFalse(p.buttons.contains { $0.value == "dismiss" })
  }

  func testOlderCardWithNoRecommendationStylesNoButtonAsDefault() throws {
    let p = try XCTUnwrap(try question("fq_old").decisionPresentation(card: try card("fq_old")))
    XCTAssertEqual(p.buttons.map(\.value), ["wait for review", "merge now"], "an unrecommended bypass goes last")
    XCTAssertFalse(p.buttons.contains(where: \.recommended), "a bypass is never the default unless recommended")
    XCTAssertTrue(try XCTUnwrap(p.buttons.first { $0.value == "merge now" }).adminBypass)
    // Its old generic quick replies are not options, so they stay.
    XCTAssertEqual(p.quickReplies.count, 1)
  }

  func testSparseCardHasNoAnswerButtons() throws {
    let p = try XCTUnwrap(try question("fq_sparse").decisionPresentation(card: try card("fq_sparse")))
    XCTAssertTrue(p.buttons.isEmpty, "Dismiss is the row's own button")
    XCTAssertTrue(p.quickReplies.isEmpty)
  }

  func testRenderedActionsHaveNoDuplicatesAndQuickRepliesDropOptions() throws {
    let view = FleetDecisionView(
      decision: .init(question: "Merge or wait?", options: [
        .init(value: "merge both", label: "Merge both", adminBypass: true),
        .init(value: "wait for teammate review", label: "Wait for teammate review", recommended: true),
        .init(value: "Wait for teammate review", label: "wait for TEAMMATE review"),
      ], unknown: false),
      recommendation: .init(option: "wait for teammate review", label: "Wait for teammate review", unknown: false)
    )
    let card = FleetCardBrief(
      id: "q1",
      decisionView: view,
      primaryAction: FleetCardAction(op: "answer", label: "Wait for teammate review", value: "wait for teammate review", recommended: true),
      secondaryAction: FleetCardAction(op: "answer", label: "Merge both (admin bypass)", value: "merge both", adminBypass: true),
      extraActions: [
        FleetCardAction(op: "answer", label: "Merge Both", value: "MERGE BOTH"),
        FleetCardAction(op: "defer", label: "Later", value: "dismiss"),
      ],
      suggestedReplies: [
        "Merge both", "WAIT FOR TEAMMATE REVIEW", "Merge both (admin bypass)", "Use admin bypass and merge",
        "Ask for a status update", "ask for a status update ",
      ]
    )
    let p = try XCTUnwrap(FleetDecisionPresentation.make(question: nil, card: card))
    let keys = p.buttons.map { FleetDecisionPresentation.normalized($0.value) }
    XCTAssertEqual(keys.count, Set(keys).count, "no option appears as two buttons")
    XCTAssertEqual(p.buttons.map(\.label), ["Wait for teammate review", "Merge both"])
    XCTAssertEqual(p.buttons.map(\.adminBypass), [false, true], "the bypass is labelled by its caption")
    XCTAssertEqual(p.buttons.filter(\.recommended).count, 1)
    XCTAssertEqual(p.quickReplies, ["Ask for a status update"], "a reply equal to an option, or a bypass, is dropped")

    // With the question, a button is only an answer the question takes.
    let q = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"q1","title":"Merge?","options":["merge both","Wait for teammate review","dismiss","open thread"]}
      """.utf8))
    let withQuestion = try XCTUnwrap(q.decisionPresentation(card: card))
    XCTAssertEqual(withQuestion.buttons.map(\.value), ["Wait for teammate review", "merge both"])
  }

  func testDisplayTextFlattensTablesAndDropsInternalIDs() {
    let raw = """
      Both are ready, see paseo:srv_test.0000-1 and fq_regression in /Users/me/work/repo/file.swift:
      | PR | Certificate |
      |---|---|
      | **#1201** reports | ✅ passed |
      Threads 5/5 resolved; and/or wait.
      """
    let text = FleetDecisionPresentation.displayText(raw)
    XCTAssertFalse(text.contains("|"))
    XCTAssertFalse(text.contains("paseo:"))
    XCTAssertFalse(text.contains("srv_"))
    XCTAssertFalse(text.contains("fq_"))
    // Paths stay: a permission prompt's command target is the decision.
    XCTAssertTrue(text.contains("/Users/me/work/repo/file.swift"))
    XCTAssertFalse(text.contains("**"))
    XCTAssertTrue(text.contains("PR · Certificate"))
    XCTAssertTrue(text.contains("#1201 reports · ✅ passed"))
    XCTAssertTrue(text.contains("5/5 resolved; and/or wait."))
    XCTAssertEqual(FleetDecisionPresentation.displayText("Allow npm test || rm -rf /tmp/build-output?"),
                   "Allow npm test || rm -rf /tmp/build-output?", "shell operators and paths are command text")
  }

  func testClarificationQuestionKeepsItsOwnFlow() throws {
    let q = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_regression","kind":"suggestion","title":"Clarify","options":["Answer question"]}
      """.utf8))
    XCTAssertNil(q.decisionPresentation(card: try card("fq_regression")))
  }

  // MARK: PR #391 review findings

  /// A PR-ready card keeps its own merge buttons: no answer buttons are
  /// synthesized from its options.
  func testSpecializedPRCardFallsBackToItsOwnButtons() throws {
    let json = """
    {"id": "fq_spec", "questionId": "fq_spec", "kind": "merge_ready",
     "primaryAction": {"op": "merge", "label": "Merge PR", "value": "acme/app#412"},
     "extraActions": [{"op": "merge_and_deploy", "label": "Merge & Deploy", "value": "acme/app#412"}],
     "decisionView": {"version": 1, "goal": {"title": null, "text": "Ship it", "unknown": false},
       "status": {"done": [], "blocked": [], "unverified": [], "prs": [], "unknown": true},
       "decision": {"question": "Merge PR #412?", "options": [{"value": "merge now", "label": "Merge now", "consequence": null, "adminBypass": false, "recommended": false}], "unknown": false},
       "recommendation": {"option": null, "label": null, "why": null, "unknown": true}, "unknowns": [], "evidence": []}}
    """
    let card = try JSONDecoder().decode(FleetCardBrief.self, from: Data(json.utf8))
    XCTAssertNotNil(card.decisionView)
    XCTAssertNil(FleetDecisionPresentation.make(question: nil, card: card))
  }

}
