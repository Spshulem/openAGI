import SupervisorChannelsKit
import XCTest
@testable import OpenAGI

/// Needs You on iPhone: which cards are listed and counted, what each row
/// says, and what the decision screen offers. Uses the synthetic review
/// fixture (long and noisy titles, FYIs mixed in).
final class NeedsYouListDetailTests: XCTestCase {
    private func fixture() throws -> FleetState {
        try JSONDecoder().decode(FleetState.self, from: Data(UITestNeedsYouFixture.stateJSON.utf8))
    }

    func testOnlyActionableCardsAreListedAndCounted() throws {
        let state = try fixture()
        XCTAssertEqual(state.cards.count, 15)
        let listed = SupervisorFormat.resolvedCards(state)
        XCTAssertEqual(listed.count, 12, "FYIs and completions are not Needs You")
        XCTAssertFalse(listed.contains { $0.id.hasPrefix("fyi-") })
        XCTAssertEqual(SupervisorAttentionCounting.needsYouTotal(needsYouFlags: state.cards.map(\.needsYou), pendingApprovals: 0), listed.count)
    }

    func testDigestKeepsContextOrderAndDropsRepeats() throws {
        let card = try XCTUnwrap(try fixture().cards.first { $0.id == "ny-deploy" })
        let digest = card.needsYouDigest
        XCTAssertEqual(Array(digest.sections.map(\.kind).prefix(5)), [.goal, .state, .blocker, .decision, .recommendation])
        // brief.whatChanged and summary carry the same text: shown once.
        XCTAssertEqual(digest.sections(.state).count, 1)
        XCTAssertEqual(digest.reason, "Merging deploys to production. Only you can approve a production deploy.")
        XCTAssertEqual(card.needsYouBadge, SupervisorNeedsYouBadge(text: "Risky", tone: .caution))
        XCTAssertEqual(card.needsYouProject, "atlas")
    }

    func testFailingChecksOutrankRiskInTheBadge() throws {
        let card = try XCTUnwrap(try fixture().cards.first { $0.id == "ny-ci" })
        XCTAssertEqual(card.needsYouBadge, SupervisorNeedsYouBadge(text: "Checks failing", tone: .alert))
    }

    func testAgentOptionsBecomeTheDecisionAndReplyUsesTheChat() {
        let card = SupervisorCard(id: "c", kind: "agent-ask", headline: "Which region?", threadKey: "codex:a",
                                  options: ["us-east-2", "eu-west-1", "open thread", "dismiss"])
        let actions = NeedsYouActions(card: card)
        XCTAssertEqual(actions.decisions.map(\.label), ["Us-east-2", "Eu-west-1"])
        XCTAssertEqual(actions.decisions.map(\.value), ["us-east-2", "eu-west-1"])
        XCTAssertEqual(actions.decisions.first?.op, "answer")
        XCTAssertTrue(actions.canReply, "a thread can be answered from the one Supervisor composer")
        XCTAssertEqual(actions.dismiss.op, "dismiss")
    }

    func testMergeReadyKeepsItsPrimaryAndLaterReadsAsDismiss() {
        let card = SupervisorCard(id: "m", kind: "merge_ready", headline: "PR #77 ready",
                                  primaryAction: SupervisorCardAction(op: "merge", label: "Merge"),
                                  secondaryAction: SupervisorCardAction(op: "defer", label: "Later", value: "later"),
                                  extraActions: [SupervisorCardAction(op: "dismiss", label: "Dismiss"),
                                                 SupervisorCardAction(op: "merge_deploy", label: "Merge & deploy")])
        let actions = NeedsYouActions(card: card)
        XCTAssertEqual(actions.decisions.map(\.label), ["Merge", "Merge & deploy"])
        XCTAssertEqual(actions.dismiss.label, "Dismiss")
        XCTAssertEqual(actions.dismiss.op, "defer")
    }

    func testCompletionOffersNoDecision() {
        let card = SupervisorCard(id: "d", kind: "completed", headline: "Finished", canReply: true,
                                  primaryAction: SupervisorCardAction(op: "open_chat", label: "View Chat"))
        let actions = NeedsYouActions(card: card)
        XCTAssertTrue(actions.decisions.isEmpty)
        XCTAssertTrue(actions.canReply)
    }

    func testMetaNamesTheThemeAndAge() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let card = SupervisorCard(id: "x", headline: "H", noticedAt: now.addingTimeInterval(-3 * 3600), subchannel: "atlas/Checkout")
        let meta = card.needsYouMeta(now: now)
        XCTAssertTrue(meta?.hasPrefix("/Checkout · ") == true, meta ?? "nil")
    }
}
