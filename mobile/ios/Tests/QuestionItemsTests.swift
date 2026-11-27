import XCTest
@testable import OpenAGI

/// Needs You asks with several questions (card.questionItems,
/// src/fleet/decision-items.js): decoding the synthetic
/// `--ui-question-items-fixture` cards, drafts that persist and resume, and
/// the `answer_items` payload (only drafted items and skip ids, never a
/// group reply or a recommendation applied for the owner).
final class QuestionItemsTests: XCTestCase {
    private func cards() throws -> [String: SupervisorCard] {
        let state = try JSONDecoder().decode(FleetState.self, from: Data(UITestQuestionItemsFixture.stateJSON.utf8))
        return Dictionary(state.cards.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func freshDefaults() -> UserDefaults {
        let name = "question-items-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    // MARK: Decoding

    func testFreshTenQuestionCardDecodesEveryItem() throws {
        let card = try XCTUnwrap(try cards()["fq_release"])
        XCTAssertTrue(card.hasQuestionWalkthrough)
        XCTAssertEqual(card.questionItems.count, 10)
        XCTAssertEqual(card.questionItems.map(\.index), Array(1...10))
        XCTAssertTrue(card.questionItems.allSatisfy { $0.state.status == "unanswered" })
        let canvas = card.questionItems[2]
        XCTAssertEqual(canvas.displayLabel, "Canvas pages")
        XCTAssertEqual(canvas.choices, ["Pages inside one document", "Separate documents"])
        XCTAssertTrue(canvas.freeText)
        XCTAssertEqual(canvas.recommendation, "The owner recommends separate documents.")
        XCTAssertNotNil(card.questionItems[7].unblocks)
        XCTAssertTrue(card.questionItems[0].choices.isEmpty)
        XCTAssertTrue(card.questionItems[0].freeText)
        let summary = try XCTUnwrap(card.questionItemsSummary)
        XCTAssertEqual(summary.total, 10)
        XCTAssertEqual(summary.open, 10)
        XCTAssertEqual(card.primaryAction?.op, "review_items")
        XCTAssertEqual(card.secondaryAction?.label, "Later")
        XCTAssertEqual(QuestionItemsText.reviewLabel(card.questionItemsCounts), "Review 10 questions")
    }

    func testPartiallyAnsweredCardKeepsEachItemState() throws {
        let card = try XCTUnwrap(try cards()["fq_release_partial"])
        let byIndex = Dictionary(card.questionItems.map { ($0.index, $0) }, uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(byIndex[1]?.state.status, "skipped")
        XCTAssertEqual(byIndex[3]?.state.status, "delivered")
        XCTAssertEqual(byIndex[3]?.state.answer, "Separate documents")
        XCTAssertEqual(byIndex[4]?.state.status, "failed")
        XCTAssertEqual(byIndex[4]?.state.answer, "Yes", "a failed item keeps its answer for Retry")
        XCTAssertEqual(byIndex[4]?.state.detail, "host offline")
        XCTAssertEqual(byIndex[2]?.state.status, "unanswered")
        XCTAssertEqual(card.questionItemsCounts.open, 9)
        XCTAssertEqual(QuestionItemsText.summary(card.questionItemsCounts),
                       "10 questions · 1 delivered · 1 failed · 1 skipped · 7 not answered")
        XCTAssertEqual(QuestionItemStatusStyle.of(try XCTUnwrap(byIndex[3])).text, "Delivered")
        XCTAssertEqual(QuestionItemStatusStyle.of(try XCTUnwrap(byIndex[4])).text, "Failed")
        XCTAssertEqual(QuestionItemStatusStyle.of(try XCTUnwrap(byIndex[1])).text, "Skipped")
        XCTAssertEqual(QuestionItemStatusStyle.of(try XCTUnwrap(byIndex[2])).text, "Not answered")
    }

    func testGroupedCardOffersNoGroupAnswerOrRecommendationButton() throws {
        for id in ["fq_release", "fq_release_partial"] {
            let card = try XCTUnwrap(try cards()[id])
            XCTAssertFalse(DecisionContract.ownsActions(card), "\(id): answered question by question")
            XCTAssertTrue(DecisionContract.choices(for: card).isEmpty, "\(id): Review N questions is not an option")
            XCTAssertTrue(DecisionContract.passthrough([card.primaryAction].compactMap { $0 }).isEmpty)
            XCTAssertTrue(NeedsYouActions(card: card).decisions.isEmpty, "\(id): no decision button that sends")
            XCTAssertNil(card.decisionView?.recommendation.option, "\(id): no recommendation to apply")
            XCTAssertTrue(card.decisionView?.decision.options.isEmpty ?? true)
        }
    }

    func testSingleQuestionCardKeepsTheDecisionContract() throws {
        let card = try XCTUnwrap(try cards()["fq_single"])
        XCTAssertTrue(card.questionItems.isEmpty)
        XCTAssertNil(card.questionItemsSummary)
        XCTAssertFalse(card.hasQuestionWalkthrough)
        XCTAssertTrue(DecisionContract.ownsActions(card))
        XCTAssertEqual(DecisionContract.choices(for: card).map(\.label), ["Deploy", "Hold"])
    }

    func testCompletedFyiNeverOffersTheWalkthrough() throws {
        let card = try XCTUnwrap(try cards()["fq_fyi_done"])
        XCTAssertEqual(card.questionItems.count, 2, "it carries items")
        XCTAssertEqual(card.askType, "fyi")
        XCTAssertFalse(card.needsYou)
        XCTAssertFalse(card.hasQuestionWalkthrough, "a completion or FYI is never an owner ask")
        var asDecisionKind = card
        asDecisionKind.kind = "approval"
        XCTAssertFalse(asDecisionKind.hasQuestionWalkthrough, "askType fyi alone keeps it out")
        var asDecisionAsk = card
        asDecisionAsk.askType = "decision"
        XCTAssertFalse(asDecisionAsk.hasQuestionWalkthrough, "kind completed alone keeps it out")
    }

    func testLenientItemDecoding() throws {
        let json = #"""
        {"id":"c","headline":"h","questionItems":[
          {"itemId":"a","index":0,"question":"Ship it?","choices":["Yes",""],"state":{"status":"weird"}},
          {"itemId":"b","index":2,"question":"Who reviews?","freeText":false},
          {"index":3,"question":"no id"},
          {"itemId":"d","index":1,"question":""},
          "garbage"
        ],"questionItemsSummary":{"total":"x","unanswered":1,"skipped":1,"failed":1}}
        """#
        let card = try JSONDecoder().decode(SupervisorCard.self, from: Data(json.utf8))
        XCTAssertEqual(card.questionItems.map(\.itemId), ["a", "b"], "items without an id or question are dropped")
        XCTAssertEqual(card.questionItems[0].displayLabel, "Main decision")
        XCTAssertEqual(card.questionItems[0].choices, ["Yes"])
        XCTAssertEqual(card.questionItems[0].state.status, "unanswered", "an unknown status reads as unanswered")
        XCTAssertTrue(card.questionItems[1].freeText, "no choices means the answer is typed")
        XCTAssertEqual(card.questionItems[1].displayLabel, "Question 2")
        XCTAssertEqual(card.questionItemsSummary?.open, 3, "open is unanswered + skipped + failed when absent")
        XCTAssertTrue(card.hasQuestionWalkthrough)

        let wrongType = try JSONDecoder().decode(SupervisorCard.self, from: Data(#"{"id":"c","headline":"h","questionItems":"nope"}"#.utf8))
        XCTAssertTrue(wrongType.questionItems.isEmpty)
        XCTAssertFalse(wrongType.hasQuestionWalkthrough)
    }

    func testActResultDecodesUpdatedItems() throws {
        let json = #"""
        {"result":{"ok":false,"kind":"answer_items","status":"failed","detail":"host offline",
          "items":[{"itemId":"q4","index":4,"question":"Drop it?","choices":["Yes","No"],
                    "state":{"status":"failed","answer":"Yes","detail":"host offline"}}]},
         "state":{"mode":"observe","cards":[]}}
        """#
        let result = try JSONDecoder().decode(FleetCardActResult.self, from: Data(json.utf8))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.kind, "answer_items")
        XCTAssertEqual(result.status, "failed")
        XCTAssertEqual(result.message, "host offline")
        XCTAssertEqual(result.items.first?.state.answer, "Yes")
        XCTAssertNotNil(result.state)
    }

    // MARK: Drafts

    func testDraftStorePersistsPerQuestionAndItem() {
        let store = QuestionItemsDraftStore(defaults: freshDefaults())
        store.save(QuestionItemDraft(answer: "Yes"), questionID: "q1", itemID: "a")
        store.save(QuestionItemDraft(answer: nil, skip: true), questionID: "q1", itemID: "b")
        store.save(QuestionItemDraft(answer: "Other ask"), questionID: "q2", itemID: "a")
        XCTAssertEqual(store.draft(questionID: "q1", itemID: "a")?.answer, "Yes")
        XCTAssertEqual(store.draft(questionID: "q1", itemID: "b")?.skip, true)
        XCTAssertEqual(store.draft(questionID: "q2", itemID: "a")?.answer, "Other ask", "keyed by question id too")
        store.save(QuestionItemDraft(answer: "   "), questionID: "q1", itemID: "a")
        XCTAssertNil(store.draft(questionID: "q1", itemID: "a"), "a blank draft is no draft")
    }

    @MainActor
    func testWalkthroughResumesDraftsAndPageAfterReopening() throws {
        let card = try XCTUnwrap(try cards()["fq_release"])
        let store = QuestionItemsDraftStore(defaults: freshDefaults())
        let first = QuestionWalkthroughModel(card: card, store: store)
        XCTAssertEqual(first.pageIndex, 0)
        XCTAssertTrue(first.drafts.isEmpty, "nothing is preselected, not even a recommended choice")
        first.setText("Alex and Sam", for: card.questionItems[0].itemId)
        first.next()
        first.skipCurrent()                       // item 2 skipped, moves to item 3
        XCTAssertEqual(first.pageIndex, 2)
        first.select("Separate documents", for: card.questionItems[2].itemId)

        // Closed and opened again: same drafts, same page.
        let reopened = QuestionWalkthroughModel(card: card, store: store)
        XCTAssertEqual(reopened.pageIndex, 2)
        XCTAssertEqual(reopened.draft(for: card.questionItems[0].itemId)?.answer, "Alex and Sam")
        XCTAssertEqual(reopened.draft(for: card.questionItems[1].itemId)?.skip, true)
        XCTAssertEqual(reopened.draft(for: card.questionItems[2].itemId)?.answer, "Separate documents")

        // Picking the same choice again clears it.
        reopened.select("Separate documents", for: card.questionItems[2].itemId)
        XCTAssertNil(reopened.draft(for: card.questionItems[2].itemId))
        XCTAssertNil(store.draft(questionID: "fq_release", itemID: card.questionItems[2].itemId))
    }

    @MainActor
    func testSentItemsAreReadOnlyAndResumeSkipsThem() throws {
        let card = try XCTUnwrap(try cards()["fq_release_partial"])
        let model = QuestionWalkthroughModel(card: card, store: QuestionItemsDraftStore(defaults: freshDefaults()))
        // Starts at the first open item without a draft (index 1, skipped).
        XCTAssertEqual(model.current?.index, 1)
        let delivered = try XCTUnwrap(card.questionItems.first { $0.index == 3 })
        model.select("Pages inside one document", for: delivered.itemId)
        XCTAssertNil(model.draft(for: delivered.itemId), "a delivered answer cannot be changed here")
    }

    // MARK: Payload

    func testPayloadCarriesOnlyDraftedItemsAndSkipIds() throws {
        let card = try XCTUnwrap(try cards()["fq_release_partial"])
        let item = { (index: Int) in card.questionItems.first { $0.index == index }! }
        let drafts: [String: QuestionItemDraft] = [
            item(2).itemId: QuestionItemDraft(answer: "  The clean CI host  "),
            item(5).itemId: QuestionItemDraft(answer: nil, skip: true),
            item(1).itemId: QuestionItemDraft(answer: nil, skip: true),     // already skipped: not re-sent
            item(3).itemId: QuestionItemDraft(answer: "Pages inside one document"),  // delivered: never re-sent
            item(4).itemId: QuestionItemDraft(answer: "No"),                // failed: the changed answer goes
            item(6).itemId: QuestionItemDraft(answer: "   ")                // blank: nothing
        ]
        let payload = QuestionItemsPayload.build(items: card.questionItems, drafts: drafts)
        XCTAssertEqual(payload.answers, [
            SupervisorQuestionItemAnswer(itemId: item(2).itemId, answer: "The clean CI host"),
            SupervisorQuestionItemAnswer(itemId: item(4).itemId, answer: "No")
        ])
        XCTAssertEqual(payload.skip, [item(5).itemId])
        XCTAssertEqual(payload.sendLabel, "Send 2 answers, skip 1")
        XCTAssertTrue(QuestionItemsPayload.build(items: card.questionItems, drafts: [:]).isEmpty,
                      "no drafts, nothing to send: recommendations are never sent for the owner")
    }

    func testSendLabels() {
        let a = SupervisorQuestionItemAnswer(itemId: "a", answer: "x")
        XCTAssertEqual(QuestionItemsPayload(answers: [], skip: []).sendLabel, "Send answers")
        XCTAssertEqual(QuestionItemsPayload(answers: [a], skip: []).sendLabel, "Send 1 answer")
        XCTAssertEqual(QuestionItemsPayload(answers: [a, a], skip: []).sendLabel, "Send 2 answers")
        XCTAssertEqual(QuestionItemsPayload(answers: [], skip: ["b"]).sendLabel, "Skip 1 question")
    }

    func testRecommendedTagOnlyOnAnExactMatch() {
        XCTAssertTrue(QuestionItemsText.isRecommended("Separate documents", by: "separate documents."))
        XCTAssertFalse(QuestionItemsText.isRecommended("Separate documents", by: "The owner recommends separate documents."))
        XCTAssertFalse(QuestionItemsText.isRecommended("Yes", by: nil))
    }

    @MainActor
    func testSendAppliesResultsClearsSentDraftsAndKeepsFailedForRetry() async throws {
        let card = try XCTUnwrap(try cards()["fq_release"])
        let store = QuestionItemsDraftStore(defaults: freshDefaults())
        let model = QuestionWalkthroughModel(card: card, store: store)
        let one = card.questionItems[0], two = card.questionItems[1], three = card.questionItems[2], four = card.questionItems[3]
        model.setText("Alex", for: one.itemId)
        model.go(to: 1)
        model.skipCurrent()
        model.select("Separate documents", for: three.itemId)
        model.select("Yes", for: four.itemId)

        var sent: [([SupervisorQuestionItemAnswer], [String])] = []
        func updated(_ item: SupervisorQuestionItem, _ status: String, _ answer: String?, _ detail: String? = nil) -> SupervisorQuestionItem {
            var copy = item
            copy.state = .init(status: status, answer: answer, detail: detail)
            return copy
        }
        let result = await model.send { answers, skip in
            sent.append((answers, skip))
            return FleetCardActResult(ok: false, status: "failed", message: "host offline", kind: "answer_items", items: [
                updated(one, "queued", "Alex"), updated(two, "skipped", nil),
                updated(three, "delivered", "Separate documents"), updated(four, "failed", "Yes", "host offline")
            ])
        }
        XCTAssertNotNil(result)
        XCTAssertEqual(sent.count, 1, "one request for every drafted answer and skip")
        XCTAssertEqual(sent[0].0.map(\.itemId), [one.itemId, three.itemId, four.itemId])
        XCTAssertEqual(sent[0].0.map(\.answer), ["Alex", "Separate documents", "Yes"])
        XCTAssertEqual(sent[0].1, [two.itemId])
        XCTAssertFalse(sent[0].0.contains { $0.answer.localizedCaseInsensitiveContains("recommend") })

        XCTAssertNil(model.draft(for: one.itemId), "queued: sent, draft cleared")
        XCTAssertNil(model.draft(for: two.itemId), "skipped: recorded, draft cleared")
        XCTAssertNil(model.draft(for: three.itemId), "delivered: draft cleared")
        XCTAssertEqual(model.draft(for: four.itemId)?.answer, "Yes", "failed: answer kept")
        XCTAssertEqual(model.note, SupervisorFormat.Note(text: "host offline", isAlert: true))
        XCTAssertEqual(model.counts.failed, 1)
        XCTAssertTrue(model.payload.answers.map(\.itemId) == [four.itemId], "only the failed answer is left to send")

        // Retry sends just the failed item with its kept answer.
        let retried = await model.retry(four.itemId) { answers, skip in
            sent.append((answers, skip))
            return FleetCardActResult(ok: true, status: "delivered", kind: "answer_items",
                                      items: [updated(four, "delivered", "Yes")])
        }
        XCTAssertNotNil(retried)
        XCTAssertEqual(sent.last?.0, [SupervisorQuestionItemAnswer(itemId: four.itemId, answer: "Yes")])
        XCTAssertEqual(sent.last?.1, [])
        XCTAssertNil(model.draft(for: four.itemId))
        XCTAssertEqual(model.counts.delivered, 2)
    }

    @MainActor
    func testTransportFailureKeepsEveryDraft() async throws {
        let card = try XCTUnwrap(try cards()["fq_release"])
        let model = QuestionWalkthroughModel(card: card, store: QuestionItemsDraftStore(defaults: freshDefaults()))
        model.setText("Alex", for: card.questionItems[0].itemId)
        let result = await model.send { _, _ in throw URLError(.notConnectedToInternet) }
        XCTAssertNil(result)
        XCTAssertEqual(model.draft(for: card.questionItems[0].itemId)?.answer, "Alex")
        XCTAssertEqual(model.note?.isAlert, true)
    }

    // MARK: Transport

    func testAnswerItemsRequestBody() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let client = DaemonClient(
            server: URL(string: "http://mac.tail1234.ts.net:43210")!,
            nodeID: "mobile:abc",
            token: String(repeating: "c", count: 43),
            session: URLSession(configuration: config)
        )
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             Data(#"{"result":{"ok":true,"kind":"answer_items","status":"queued","detail":"1 answer queued for the agent.","items":[]}}"#.utf8))
        }
        let result = try await client.fleetAnswerCardItems(
            id: "fq_release",
            answers: [SupervisorQuestionItemAnswer(itemId: "q1-b1dbd1d7", answer: "Alex")],
            skip: ["q2-1102b412"]
        )
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.status, "queued")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/fleet/api/cards/fq_release/act")
        let data = try XCTUnwrap(request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var out = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                out.append(buffer, count: n)
            }
            return out
        })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["op", "items", "skip"], "no group answer value")
        XCTAssertEqual(body["op"] as? String, "answer_items")
        XCTAssertEqual(body["items"] as? [[String: String]], [["itemId": "q1-b1dbd1d7", "answer": "Alex"]])
        XCTAssertEqual(body["skip"] as? [String], ["q2-1102b412"])
    }
}
