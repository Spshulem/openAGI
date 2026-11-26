import XCTest
@testable import OpenAGI

/// The decision contract (card.decisionView, src/fleet/decision-view.js):
/// decoding the synthetic `--ui-decision-view-fixture` cards, and the
/// options the phone offers from them.
final class DecisionViewDecodingTests: XCTestCase {
    private func cards() throws -> [String: SupervisorCard] {
        let state = try JSONDecoder().decode(FleetState.self, from: Data(UITestNeedsYouFixture.decisionViewStateJSON.utf8))
        return Dictionary(state.cards.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    func testRegressionCardDecodesEverySection() throws {
        let card = try XCTUnwrap(try cards()["fq_regression"])
        let view = try XCTUnwrap(card.decisionView)
        XCTAssertEqual(view.version, 1)
        XCTAssertEqual(view.goal.title, "Sales v1 PR review")
        XCTAssertFalse(view.goal.unknown)
        XCTAssertEqual(view.status.done.count, 1)
        XCTAssertEqual(view.status.blocked.count, 2)
        XCTAssertEqual(view.status.unverified, ["The post-merge verification on main is still pending."])
        XCTAssertEqual(view.status.prs.map(\.ref), ["#1201", "#1202"])
        XCTAssertEqual(view.status.prs.last?.facts.contains("Threads: 5/5 resolved"), true)
        XCTAssertEqual(view.decision.options.map(\.label), ["Merge both", "Wait for teammate review"])
        XCTAssertEqual(view.decision.options.map(\.adminBypass), [true, false])
        XCTAssertEqual(view.decision.options.map(\.recommended), [false, true])
        XCTAssertEqual(view.recommendation.option, "wait for teammate review")
        XCTAssertTrue(view.unknowns.isEmpty)
        XCTAssertEqual(card.primaryAction?.recommended, true)
        XCTAssertEqual(card.secondaryAction?.adminBypass, true)
        XCTAssertEqual(card.secondaryAction?.recommended, false)
    }

    func testRegressionChoicesLeadWithTheRecommendationAndOfferEachOptionOnce() throws {
        let card = try XCTUnwrap(try cards()["fq_regression"])
        let choices = DecisionContract.choices(for: card)
        XCTAssertEqual(choices.map(\.label), ["Wait for teammate review", "Merge both"],
                       "the bypass suffix is a caption, not part of the label; Later is not a decision")
        XCTAssertEqual(choices.map(\.recommended), [true, false])
        XCTAssertEqual(choices.map(\.adminBypass), [false, true])
        XCTAssertEqual(choices.map(\.action.value), ["wait for teammate review", "merge both"])
        XCTAssertEqual(choices.last?.consequence, "Admin bypass: merges without the required review")
        XCTAssertTrue(DecisionContract.quickReplies(for: card).isEmpty)
    }

    func testSparseCardMarksEverySectionUnknown() throws {
        let card = try XCTUnwrap(try cards()["fq_sparse"])
        let view = try XCTUnwrap(card.decisionView)
        XCTAssertTrue(view.goal.unknown)
        XCTAssertTrue(view.status.unknown)
        XCTAssertTrue(view.decision.unknown)
        XCTAssertTrue(view.recommendation.unknown)
        XCTAssertEqual(view.unknowns.count, 5)
        XCTAssertEqual(DecisionContract.unknowns(view, in: .goal), ["Goal: not stated in the source"])
        XCTAssertEqual(DecisionContract.unknowns(view, in: .status).count, 2)
        XCTAssertTrue(DecisionContract.choices(for: card).isEmpty, "Dismiss is not a decision option")
    }

    func testUnknownRecommendationNeverPromotesTheBypass() throws {
        let card = try XCTUnwrap(try cards()["fq_old"])
        let view = try XCTUnwrap(card.decisionView)
        XCTAssertTrue(view.recommendation.unknown)
        let choices = DecisionContract.choices(for: card)
        XCTAssertFalse(choices.contains(where: \.recommended))
        XCTAssertEqual(choices.first(where: \.adminBypass)?.label, "Merge now")
        // "Proceed with the recommended option" means nothing without one.
        XCTAssertEqual(DecisionContract.quickReplies(for: card), [
            "Approved — finish all remaining in-scope items",
            "Hold off — tell me what's still unverified first"
        ])
    }

    func testOlderCardHasNoDecisionView() throws {
        let card = try XCTUnwrap(try cards()["fq_legacy"])
        XCTAssertNil(card.decisionView)
        XCTAssertTrue(DecisionContract.choices(for: card).isEmpty, "older cards keep their previous buttons")
        XCTAssertFalse(card.primaryAction?.recommended ?? true)
        XCTAssertFalse(card.secondaryAction?.adminBypass ?? true)
    }

    func testMalformedDecisionViewNeverFailsTheCard() throws {
        let json = #"{"id":"x","headline":"H","decisionView":{"goal":"not an object","status":{"done":[1,"ok"]},"decision":{"options":[{"label":"A","recommended":"yes"}]},"unknowns":null}}"#
        let card = try JSONDecoder().decode(SupervisorCard.self, from: Data(json.utf8))
        let view = try XCTUnwrap(card.decisionView)
        XCTAssertTrue(view.goal.unknown, "a missing section is labelled unknown, not dropped")
        XCTAssertEqual(view.status.done, ["ok"])
        XCTAssertFalse(view.status.unknown)
        XCTAssertEqual(view.decision.options.map(\.value), ["A"])
        XCTAssertFalse(view.decision.options.first?.recommended ?? true)
        XCTAssertTrue(view.recommendation.unknown)
        XCTAssertTrue(view.unknowns.isEmpty)
    }

    func testQuickRepliesDropOptionCopiesAndBypassText() {
        let card = SupervisorCard(id: "q", headline: "H", suggestedReplies: ["Merge both", "merge BOTH ", "Use admin bypass", "Tell me more"],
                                  options: ["merge both"])
        XCTAssertEqual(DecisionContract.quickReplies(for: card), ["Tell me more"])
    }

    func testCleanDropsTablesRoutingIdsAndPaths() {
        let raw = "Ready: | PR | CI |\n|---|---|\nSee paseo:srv_test.0001 in /Users/x/repo/file.swift, 5/5 resolved."
        XCTAssertEqual(DecisionContract.clean(raw), "See in , 5/5 resolved.")
        XCTAssertNil(DecisionContract.clean("| a | b |"))
    }
}
