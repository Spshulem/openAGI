import XCTest
@testable import OpenAGI

/// A Needs You ask with several questions (card.questionItems): decoding,
/// the single-question #391 contract left as it was, draft persistence and
/// resume, and the answer_items request (only drafted answers and skips, no
/// group reply, no recommendation sent for the owner). Uses
/// FleetQuestionItemsFixture.
@MainActor
final class FleetQuestionItemsTests: XCTestCase {
  private var suiteNames: [String] = []

  override func tearDown() async throws {
    suiteNames.forEach { UserDefaults().removePersistentDomain(forName: $0) }
    suiteNames = []
  }

  private func defaults() throws -> UserDefaults {
    let name = "FleetQuestionItemsTests.\(UUID().uuidString)"
    suiteNames.append(name)
    return try XCTUnwrap(UserDefaults(suiteName: name))
  }

  private func cards() throws -> [FleetCardBrief] {
    try JSONDecoder().decode([FleetCardBrief].self, from: Data(FleetQuestionItemsFixture.cardsJSON.utf8))
  }

  private func card(_ id: String) throws -> FleetCardBrief {
    try XCTUnwrap(try cards().first { $0.id == id })
  }

  private func state() throws -> FleetState {
    try JSONDecoder().decode(FleetState.self, from: Data(FleetQuestionItemsFixture.stateJSON.utf8))
  }

  private func question(_ id: String) throws -> FleetQuestion {
    try XCTUnwrap(try state().questions.first { $0.id == id })
  }

  private static let blanket = ["Answer all questions", "Approve recommended choices"]

  // MARK: Decoding

  func testFreshCardDecodesTenSeparateQuestions() throws {
    let card = try card("fq_release")
    XCTAssertEqual(card.questionItems.count, 10)
    XCTAssertTrue(card.hasQuestionItems)
    XCTAssertTrue(card.asksQuestionItems)
    XCTAssertEqual(card.questionItems.map(\.index), Array(1...10))
    XCTAssertEqual(card.questionItems[0].itemId, "q1-b1dbd1d7")
    XCTAssertEqual(card.questionItems[0].title, "1. Reviewers")
    XCTAssertEqual(card.questionItems[0].choices, [])
    XCTAssertTrue(card.questionItems[0].freeText)
    let canvas = card.questionItems[2]
    XCTAssertEqual(canvas.choices, ["Pages inside one document", "Separate documents"])
    XCTAssertEqual(canvas.recommendation, "The owner recommends separate documents.")
    XCTAssertNil(canvas.recommendedChoice, "a recommendation sentence names no exact choice")
    XCTAssertEqual(card.questionItems[7].unblocks, "the audit owner rates it a blocker for the next native build, not for web.")
    XCTAssertTrue(card.questionItems.allSatisfy { $0.state.status == .unanswered && $0.state.answer == nil })
    XCTAssertEqual(card.questionItemsSummary, FleetQuestionItemsSummary(total: 10, unanswered: 10, open: 10))

    XCTAssertEqual(card.primaryAction?.op, "review_items")
    XCTAssertEqual(card.primaryAction?.label, "Review 10 questions")
    XCTAssertEqual(card.secondaryAction?.op, "defer")
    XCTAssertEqual(card.extraActions, [])
    XCTAssertEqual(card.suggestedReplies, [])
    XCTAssertEqual(card.decisionView?.decision.options, [])
    XCTAssertNil(card.decisionView?.recommendation.option)
  }

  func testPartlyAnsweredCardDecodesEachItemsState() throws {
    let items = try card("fq_release_partial").questionItems
    XCTAssertEqual(items[0].state.status, .skipped)
    XCTAssertEqual(items[0].state.at, "2026-11-27T17:50:00Z")
    XCTAssertEqual(items[2].state, FleetQuestionItemState(status: .delivered, answer: "Separate documents", at: "2026-11-27T17:50:00Z"))
    XCTAssertEqual(items[3].state, FleetQuestionItemState(status: .failed, answer: "Yes", at: "2026-11-27T17:51:00Z", detail: "host offline"))
    XCTAssertEqual(items.filter { $0.state.status == .unanswered }.count, 7)
    let summary = try card("fq_release_partial").questionItemsSummary
    XCTAssertEqual(summary, FleetQuestionItemsSummary(total: 10, unanswered: 7, skipped: 1, queued: 0, delivered: 1, failed: 1, open: 9))
    XCTAssertEqual(try card("fq_release_partial").primaryAction?.label, "Review 9 questions")
  }

  func testSingleQuestionCardHasNoQuestionItems() throws {
    let card = try card("fq_single")
    XCTAssertEqual(card.questionItems, [])
    XCTAssertNil(card.questionItemsSummary)
    XCTAssertFalse(card.hasQuestionItems)
    XCTAssertFalse(card.asksQuestionItems)
    XCTAssertEqual(card.primaryAction?.op, "answer")
  }

  func testStateDecodesAllThreeCardsAndQuestions() throws {
    let state = try state()
    XCTAssertEqual(state.questions.map(\.id), ["fq_release", "fq_release_partial", "fq_single"])
    XCTAssertEqual(state.cards.map(\.questionKey), ["fq_release", "fq_release_partial", "fq_single"])
    XCTAssertEqual(state.cards.map(\.questionItems.count), [10, 10, 0])
  }

  func testItemDecodingIsLenient() throws {
    let json = #"""
    {"id":"c","questionItems":[
      {"itemId":"a","index":1,"question":"First?","choices":["Yes",3,"Yes"," ","No"],"state":{"status":"delivered","answer":"Yes"}},
      {"index":2,"question":"No id"},
      {"itemId":"b","index":2,"question":"   "},
      {"itemId":"c","index":3,"question":"Third?","freeText":false,"state":{"status":"approved-by-magic"}},
      {"itemId":"d","question":"Fourth?","choices":["One"],"freeText":false,"state":"bad"},
      {"itemId":"a","index":9,"question":"Duplicate id"},
      "not an item"
    ],"questionItemsSummary":{"total":"ten","open":2}}
    """#
    let card = try JSONDecoder().decode(FleetCardBrief.self, from: Data(json.utf8))
    XCTAssertEqual(card.questionItems.map(\.itemId), ["a", "c", "d"])
    XCTAssertEqual(card.questionItems[0].choices, ["Yes", "No"])
    XCTAssertEqual(card.questionItems[0].state.status, .delivered)
    XCTAssertTrue(card.questionItems[1].freeText, "no choices: typing is the only answer")
    XCTAssertEqual(card.questionItems[1].state.status, .unknown)
    XCTAssertFalse(FleetQuestionItemsLogic.isEditable(card.questionItems[1]), "an unknown state is never answered over")
    XCTAssertEqual(card.questionItems[2].index, 0)
    XCTAssertEqual(card.questionItems[2].title, "Main decision")
    XCTAssertFalse(card.questionItems[2].freeText)
    XCTAssertEqual(card.questionItems[2].state.status, .unanswered)
    XCTAssertEqual(card.questionItemsSummary?.total, 0)
    XCTAssertEqual(card.questionItemsSummary?.open, 2)

    let older = try JSONDecoder().decode(FleetCardBrief.self, from: Data(#"{"id":"c","questionItems":"nope"}"#.utf8))
    XCTAssertEqual(older.questionItems, [])
  }

  func testActResponseDecodes() throws {
    let json = #"{"result":{"ok":false,"kind":"answer_items","status":"failed","detail":"host offline","items":[{"itemId":"x","question":"Q?","state":{"status":"failed","answer":"Yes"}}]}}"#
    let decoded = try JSONDecoder().decode(FleetCardActResponse.self, from: Data(json.utf8))
    XCTAssertEqual(decoded.result?.status, "failed")
    XCTAssertEqual(decoded.result?.items.first?.state.answer, "Yes")
    XCTAssertNil(decoded.state)
    XCTAssertEqual(FleetQuestionItemsLogic.outcome(decoded.result), FleetNote(text: "host offline. Your answers are kept to retry.", isError: true))
  }

  // MARK: Presentation

  func testSeveralQuestionCardGetsNoAnswerButtonsOrQuickReplies() throws {
    let q = try question("fq_release")
    XCTAssertEqual(q.options, Self.blanket, "the raw question still carries the blanket options")
    let presentation = try XCTUnwrap(q.decisionPresentation(card: try card("fq_release")))
    XCTAssertEqual(presentation.buttons, [])
    XCTAssertEqual(presentation.quickReplies, [])
    XCTAssertEqual(presentation.questionItemCount, 10)
    XCTAssertEqual(FleetQuestionItemsLogic.reviewLabel(try card("fq_release")), "Review 10 questions")
    XCTAssertEqual(FleetQuestionItemsLogic.reviewLabel(try card("fq_release_partial")), "Review 9 questions")
  }

  func testSingleQuestionCardKeepsTheDecisionContract() throws {
    let q = try question("fq_single")
    let card = try card("fq_single")
    let presentation = try XCTUnwrap(q.decisionPresentation(card: card))
    XCTAssertEqual(presentation.buttons.map(\.value), ["deploy", "hold"])
    XCTAssertEqual(presentation.buttons.map(\.label), ["Deploy", "Hold"])
    XCTAssertEqual(presentation.buttons.filter(\.recommended), [])
    XCTAssertEqual(presentation.questionItemCount, 0)
    XCTAssertEqual(presentation.quickReplies, card.suggestedReplies)
    // Same as a card that never had the field.
    XCTAssertEqual(presentation, FleetDecisionPresentation.make(question: q, card: FleetCardBrief(
      id: card.id, questionId: card.questionId, needsYou: card.needsYou, kind: card.kind, decisionView: card.decisionView,
      primaryAction: card.primaryAction, secondaryAction: card.secondaryAction, extraActions: card.extraActions,
      suggestedReplies: card.suggestedReplies)))
  }

  func testCompletedAndUpdateCardsNeverAskQuestions() throws {
    let base = try card("fq_release")
    for kind in ["completed", "fyi", "COMPLETED"] {
      let done = FleetCardBrief(id: base.id, questionId: base.questionId, kind: kind, decisionView: base.decisionView, questionItems: base.questionItems)
      XCTAssertFalse(done.asksQuestionItems, kind)
    }
    let quiet = FleetCardBrief(id: base.id, questionId: base.questionId, needsYou: false, kind: "approval", questionItems: base.questionItems)
    XCTAssertFalse(quiet.asksQuestionItems)

    let consumer = FleetConsumer(itemDraftDefaults: try defaults())
    consumer.apply(try state())
    XCTAssertNotNil(consumer.questionItemsCard(for: try question("fq_release")))
    XCTAssertNil(consumer.questionItemsCard(for: try question("fq_single")))
    // An FYI question (needsYou false) never opens the walkthrough.
    let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(FleetQuestionItemsFixture.stateJSON.utf8)) as? [String: Any])
    var questions = try XCTUnwrap(raw["questions"] as? [[String: Any]])
    questions[0]["needsYou"] = false
    var fyi = raw
    fyi["questions"] = questions
    consumer.apply(try JSONDecoder().decode(FleetState.self, from: JSONSerialization.data(withJSONObject: fyi)))
    let q = try XCTUnwrap(consumer.question("fq_release"))
    XCTAssertNil(consumer.questionItemsCard(for: q))
    consumer.startWalkthrough(q)
    XCTAssertNil(consumer.walkthroughs["fq_release"])
  }

  // MARK: Requests

  func testNothingIsSentWithoutTheOwnersOwnAnswers() throws {
    let items = try card("fq_release").questionItems
    XCTAssertTrue(FleetQuestionItemsLogic.request(items: items, drafts: [:]).isEmpty, "no recommendation is ever preselected")
    // Even a recommendation that names a choice exactly is only a tag.
    var exact = items[6]
    exact.recommendation = "Yes"
    XCTAssertEqual(exact.recommendedChoice, "Yes")
    XCTAssertTrue(FleetQuestionItemsLogic.request(items: [exact], drafts: [:]).isEmpty)
    XCTAssertEqual(FleetQuestionItemsLogic.sendLabel(FleetAnswerItemsRequest()), "Send answers")
  }

  func testRequestCarriesOnlyDraftedAnswersAndSkips() throws {
    let items = try card("fq_release").questionItems
    let drafts: [String: FleetQuestionItemDraft] = [
      "q3-ff23e326": .init(answer: " Separate documents "),
      "q7-a068554e": .init(answer: "Yes"),
      "q2-1102b412": .init(skipped: true),
      "q5-7e1f26ac": .init(answer: "Approve recommended choices"),
      "q6-94676d03": .init(answer: "   "),
    ]
    let request = FleetQuestionItemsLogic.request(items: items, drafts: drafts)
    XCTAssertEqual(request.answers, [.init(itemId: "q3-ff23e326", answer: "Separate documents"), .init(itemId: "q7-a068554e", answer: "Yes")])
    XCTAssertEqual(request.skip, ["q2-1102b412"])
    XCTAssertEqual(FleetQuestionItemsLogic.sendLabel(request), "Send 2 answers · skip 1")

    let body = request.body
    XCTAssertEqual(Set(body.keys), ["op", "items", "skip"])
    XCTAssertEqual(body["op"] as? String, "answer_items")
    let data = try JSONSerialization.data(withJSONObject: body)
    let text = String(decoding: data, as: UTF8.self)
    for phrase in Self.blanket + ["Approve recommended", "Answer all", "recommend"] {
      XCTAssertFalse(text.localizedCaseInsensitiveContains(phrase), phrase)
    }
    XCTAssertNil(body["value"], "no group answer value")
    let sentItems = try XCTUnwrap(body["items"] as? [[String: String]])
    XCTAssertEqual(sentItems, [["itemId": "q3-ff23e326", "answer": "Separate documents"], ["itemId": "q7-a068554e", "answer": "Yes"]])
  }

  func testGroupAnswersAreRecognised() {
    for text in ["Answer all questions", "approve recommended choices", "Accept recommendations", "Approve all", " answer every question "] {
      XCTAssertTrue(FleetQuestionItemsLogic.isGroupAnswer(text), text)
    }
    for text in ["Yes", "Separate documents", "Approve #101 only", "Restart it"] {
      XCTAssertFalse(FleetQuestionItemsLogic.isGroupAnswer(text), text)
    }
  }

  func testPartlyAnsweredCardKeepsDeliveredReadOnlyAndRetriesTheFailedAnswer() throws {
    let items = try card("fq_release_partial").questionItems
    let drafts: [String: FleetQuestionItemDraft] = [
      "q3-ff23e326": .init(answer: "Pages inside one document"), // delivered: read-only
      "q1-b1dbd1d7": .init(skipped: true), // already skipped on the hub
      "q9-2c0e4391": .init(answer: "Restart it"),
    ]
    let request = FleetQuestionItemsLogic.request(items: items, drafts: drafts)
    XCTAssertEqual(request.answers.map(\.itemId), ["q4-9843173b", "q9-2c0e4391"])
    XCTAssertEqual(request.answers[0].answer, "Yes", "the failed answer is kept to resend")
    XCTAssertEqual(request.skip, [])
    XCTAssertFalse(FleetQuestionItemsLogic.isEditable(items[2]))
    XCTAssertEqual(FleetQuestionItemsLogic.badge(items[2], draft: drafts["q3-ff23e326"]), .delivered)
    XCTAssertEqual(FleetQuestionItemsLogic.badge(items[3], draft: nil), .failed)
    XCTAssertEqual(FleetQuestionItemsLogic.badge(items[0], draft: nil), .skipped)
    XCTAssertEqual(FleetQuestionItemsLogic.badge(items[1], draft: nil), .notAnswered)
    XCTAssertEqual(FleetQuestionItemsLogic.badge(items[8], draft: drafts["q9-2c0e4391"]), .draft)
    XCTAssertEqual(FleetQuestionItemsLogic.summaryLine(items), "10 questions · 1 delivered · 1 failed · 1 skipped · 7 not answered")

    let retry = FleetQuestionItemsLogic.request(items: items, drafts: drafts, only: ["q4-9843173b"])
    XCTAssertEqual(retry, FleetAnswerItemsRequest(answers: [.init(itemId: "q4-9843173b", answer: "Yes")], skip: []))
    // Skipping a failed question drops its kept answer from the send.
    let skipFailed = FleetQuestionItemsLogic.request(items: items, drafts: ["q4-9843173b": .init(skipped: true)])
    XCTAssertEqual(skipFailed.skip, ["q4-9843173b"])
    XCTAssertEqual(skipFailed.answers, [])
  }

  func testWalkthroughStartsAtTheFirstOpenQuestionAndShowsProgress() throws {
    let partial = try card("fq_release_partial").questionItems
    XCTAssertEqual(FleetQuestionItemsLogic.startIndex(items: partial, drafts: [:]), 1, "skipped q1 is passed over, q2 is next")
    XCTAssertEqual(FleetQuestionItemsLogic.startIndex(items: partial, drafts: ["q2-1102b412": .init(answer: "Host A")]), 3)
    XCTAssertEqual(FleetQuestionItemsLogic.startIndex(items: partial, drafts: [:], saved: 6), 6)
    XCTAssertEqual(FleetQuestionItemsLogic.startIndex(items: partial, drafts: [:], saved: 42), 1)
    XCTAssertEqual(FleetQuestionItemsLogic.progress(index: 2, total: 10), "3 of 10")
  }

  // MARK: Consumer: drafts, resume, sending

  func testDraftsPersistPerQuestionAndItemAndResume() throws {
    let store = try defaults()
    let first = FleetConsumer(itemDraftDefaults: store)
    first.apply(try state())
    let q = try XCTUnwrap(first.question("fq_release"))
    first.startWalkthrough(q)
    XCTAssertEqual(first.walkthroughs["fq_release"], 0)
    first.setItemAnswer("Separate documents", questionId: q.id, itemId: "q3-ff23e326")
    first.skipItem(questionId: q.id, itemId: "q2-1102b412")
    first.moveWalkthrough(q.id, to: 3)
    first.setItemAnswer("  ", questionId: q.id, itemId: "q7-a068554e")
    XCTAssertEqual(first.itemDrafts["fq_release"]?.count, 2)

    let saved = FleetQuestionItemDraftStore(defaults: store).load("fq_release")
    XCTAssertEqual(saved.drafts["q3-ff23e326"], FleetQuestionItemDraft(answer: "Separate documents"))
    XCTAssertEqual(saved.drafts["q2-1102b412"], FleetQuestionItemDraft(skipped: true))
    XCTAssertEqual(saved.position, 3)

    // A relaunch: the drafts and the page come back.
    let second = FleetConsumer(itemDraftDefaults: store)
    second.apply(try state())
    XCTAssertEqual(second.itemDrafts["fq_release"], saved.drafts)
    XCTAssertNil(second.walkthroughs["fq_release"], "the walkthrough opens only on Review")
    second.startWalkthrough(try XCTUnwrap(second.question("fq_release")))
    XCTAssertEqual(second.walkthroughs["fq_release"], 3)
    XCTAssertEqual(second.pendingItemsRequest(for: q).itemIds, ["q3-ff23e326", "q2-1102b412"])

    // The question closes: its drafts go.
    second.apply(try JSONDecoder().decode(FleetState.self, from: Data(#"{"enabled":true,"questions":[]}"#.utf8)))
    XCTAssertNil(second.itemDrafts["fq_release"])
    XCTAssertEqual(FleetQuestionItemDraftStore(defaults: store).load("fq_release"), .init())
  }

  func testSendPostsOnlyDraftsAndKeepsFailedAnswers() async throws {
    var requests: [URLRequest] = []
    let delivered = try Self.stateData { items in
      items[2]["state"] = ["status": "delivered", "answer": "Separate documents"]
      items[6]["state"] = ["status": "failed", "answer": "Yes", "detail": "host offline"]
      items[1]["state"] = ["status": "skipped"]
    }
    let consumer = FleetConsumer(
      fetchDetail: { request in (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!) },
      send: { request in
        requests.append(request)
        let state = String(decoding: delivered, as: UTF8.self)
        let body = #"{"result":{"ok":false,"kind":"answer_items","status":"failed","detail":"host offline"},"state":\#(state)}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      },
      itemDraftDefaults: try defaults())
    consumer.apply(try state())
    let q = try XCTUnwrap(consumer.question("fq_release"))

    // Nothing drafted: nothing sent.
    await consumer.sendItemAnswers(q)
    XCTAssertTrue(requests.isEmpty)
    XCTAssertEqual(consumer.itemNotes[q.id]?.isError, true)

    consumer.setItemAnswer("Separate documents", questionId: q.id, itemId: "q3-ff23e326")
    consumer.setItemAnswer("Yes", questionId: q.id, itemId: "q7-a068554e")
    consumer.skipItem(questionId: q.id, itemId: "q2-1102b412")
    await consumer.sendItemAnswers(q)

    XCTAssertEqual(requests.count, 1)
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/fleet/api/cards/fq_release/act")
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(body["op"] as? String, "answer_items")
    XCTAssertEqual(body["items"] as? [[String: String]], [["itemId": "q3-ff23e326", "answer": "Separate documents"], ["itemId": "q7-a068554e", "answer": "Yes"]])
    XCTAssertEqual(body["skip"] as? [String], ["q2-1102b412"])
    XCTAssertNil(body["value"])

    // Delivered and skipped drafts clear; the failed answer stays to retry.
    XCTAssertEqual(consumer.itemDrafts[q.id], ["q7-a068554e": FleetQuestionItemDraft(answer: "Yes")])
    XCTAssertEqual(consumer.itemNotes[q.id], FleetNote(text: "host offline. Your answers are kept to retry.", isError: true))
    XCTAssertFalse(consumer.itemsInFlight.contains(q.id))
    let card = try XCTUnwrap(consumer.cardBriefs[q.id])
    XCTAssertEqual(card.questionItems[6].state.status, .failed)
    XCTAssertEqual(consumer.pendingItemsRequest(for: q, only: ["q7-a068554e"]).answers, [.init(itemId: "q7-a068554e", answer: "Yes")])
  }

  func testABlanketAnswerIsNeverSentForASeveralQuestionAsk() async throws {
    var requests: [URLRequest] = []
    let consumer = FleetConsumer(
      fetchDetail: { request in (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!) },
      send: { request in
        requests.append(request)
        return (Data(), HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
      },
      itemDraftDefaults: try defaults())
    consumer.apply(try state())
    let q = try XCTUnwrap(consumer.question("fq_release"))
    for option in Self.blanket {
      await consumer.answer(q, option: option)
      XCTAssertEqual(consumer.notes[q.id]?.isError, true)
    }
    XCTAssertTrue(requests.isEmpty)
    XCTAssertEqual(FleetConsumer.cardActPath("a b/c:d"), "/fleet/api/cards/a%20b%2Fc%3Ad/act")
  }

  /// The fixture state with the fresh card's items edited.
  private static func stateData(_ edit: (inout [[String: Any]]) -> Void) throws -> Data {
    var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(FleetQuestionItemsFixture.stateJSON.utf8)) as? [String: Any])
    var cards = try XCTUnwrap(raw["cards"] as? [[String: Any]])
    var items = try XCTUnwrap(cards[0]["questionItems"] as? [[String: Any]])
    edit(&items)
    cards[0]["questionItems"] = items
    raw["cards"] = cards
    return try JSONSerialization.data(withJSONObject: raw)
  }
}
