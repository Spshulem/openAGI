import Foundation
import XCTest
@testable import OpenAGI

@MainActor
final class FleetOverlayTests: XCTestCase {
  func testStateDecodeDropsBadQuestionsAndFiltersDismiss() throws {
    let state = try JSONDecoder().decode(FleetState.self, from: Data("""
      {"mode":"propose","enabled":true,"running":false,"lastTickAt":"2026-09-29T10:00:00.000Z",
       "lastError":null,"snapshot":{"threads":[]},"actions":[],
       "questions":[
         {"id":"fq_1","kind":"agent-ask","title":"Which branch?","body":"The agent asked.",
          "options":["main","dismiss","release",7],"threadKey":"codex:t1","pinned":true,
          "reviewReason":"still waiting","reviewCategory":"live"},
         {"title":"no id, dropped"},
         {"id":"fq_2","title":42,"body":["wrong"],"options":"nope","pinned":"yes"}
       ]}
      """.utf8))
    XCTAssertEqual(state.mode, "propose")
    XCTAssertTrue(state.enabled)
    XCTAssertEqual(state.questions.map(\.id), ["fq_1", "fq_2"])
    XCTAssertEqual(state.questions[0].options, ["main", "release"])
    XCTAssertEqual(state.questions[0].reviewNote, "Supervisor: still waiting")
    let fallback = state.questions[1]
    XCTAssertEqual(fallback.title, "(untitled)")
    XCTAssertEqual(fallback.body, "")
    XCTAssertEqual(fallback.options, [])
    XCTAssertFalse(fallback.pinned)
    XCTAssertNil(fallback.reviewNote)
  }

  func testWrongTypedStateFieldsFallBack() throws {
    let state = try JSONDecoder().decode(FleetState.self, from: Data("""
      {"mode":3,"enabled":"yes","running":null,"questions":{"not":"an array"}}
      """.utf8))
    XCTAssertEqual(state.mode, "observe")
    XCTAssertFalse(state.enabled)
    XCTAssertFalse(state.running)
    XCTAssertTrue(state.questions.isEmpty)
  }

  func testReopenedQuestionSaysTheOwnerOverrodeTheReview() throws {
    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_3","title":"Stale?","pinned":true,"reviewCategory":"stale","reviewReason":"thread moved on"}
      """.utf8))
    XCTAssertEqual(question.reviewNote, "You reopened it. The supervisor had said: thread moved on")
  }

  func testOutcomeMapping() {
    typealias R = FleetQuestionResponse
    let queued = FleetConsumer.outcome(R(question: .init(id: "q", status: "answered"),
      delivery: FleetDelivery(status: "queued", detail: nil), state: nil), dismissed: false)
    XCTAssertEqual(queued.text, "Saved. It goes to the agent once the Mac can type.")
    XCTAssertFalse(queued.isError)

    let queuedDetail = FleetConsumer.outcome(R(question: nil,
      delivery: FleetDelivery(status: "queued", detail: "Saved. Waiting for unlock."), state: nil), dismissed: false)
    XCTAssertEqual(queuedDetail.text, "Saved. Waiting for unlock.")

    let blocked = FleetConsumer.outcome(R(question: .init(id: "q", status: "open"),
      delivery: FleetDelivery(status: "blocked", detail: "No route to the thread"), state: nil), dismissed: false)
    XCTAssertEqual(blocked.text, "No route to the thread")
    XCTAssertTrue(blocked.isError)

    let openNoDetail = FleetConsumer.outcome(R(question: .init(id: "q", status: "open"),
      delivery: FleetDelivery(status: "failed", detail: "  "), state: nil), dismissed: false)
    XCTAssertEqual(openNoDetail.text, "Not sent yet. The question is still open.")
    XCTAssertTrue(openNoDetail.isError)

    let openThread = FleetConsumer.outcome(R(question: .init(id: "q", status: "open"),
      delivery: FleetDelivery(status: "blocked", detail: "Answer in the original thread, then scan again."), state: nil),
      dismissed: false)
    XCTAssertEqual(openThread.text, "Answer in the original thread, then scan again.")
    XCTAssertTrue(openThread.isError)

    let sent = FleetConsumer.outcome(R(question: .init(id: "q", status: "answered"),
      delivery: FleetDelivery(status: "sent", detail: "typed"), state: nil), dismissed: false)
    XCTAssertEqual(sent.text, "Sent to the agent.")
    XCTAssertFalse(sent.isError)

    let dryRun = FleetConsumer.outcome(R(question: .init(id: "q", status: "answered"),
      delivery: FleetDelivery(status: "dry-run", detail: nil), state: nil), dismissed: false)
    XCTAssertEqual(dryRun.text, "Saved. Dry run, nothing sent.")

    let answered = FleetConsumer.outcome(R(question: .init(id: "q", status: "answered"), delivery: nil, state: nil),
      dismissed: false)
    XCTAssertEqual(answered.text, "Answered.")

    let dismissed = FleetConsumer.outcome(nil, dismissed: true)
    XCTAssertEqual(dismissed.text, "Dismissed.")
    XCTAssertFalse(dismissed.isError)
  }

  func testStatusLine() {
    let now = ISO8601DateFormatter().date(from: "2026-09-29T10:04:00Z")!
    let status = FleetStatus(mode: "propose", enabled: true, running: false,
                             lastTickAt: "2026-09-29T10:00:00.000Z", lastError: nil)
    XCTAssertEqual(FleetConsumer.statusLine(status, count: 3, now: now), "Scanned 4m ago · 3 need you · Propose")
    XCTAssertEqual(FleetConsumer.statusLine(status, count: 1, now: now), "Scanned 4m ago · 1 needs you · Propose")

    let never = FleetStatus(mode: "observe", enabled: false, running: false, lastTickAt: nil, lastError: nil)
    XCTAssertEqual(FleetConsumer.statusLine(never, count: 0, now: now),
                   "Not scanned yet · nothing needs you · Observe · auto-scan off")
  }

  func testChatAboutQuestionScopesTheSupervisorTab() throws {
    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_9","kind":"agent-ask","title":"Merge the PR?","body":"CI is green.","options":["yes","no"]}
      """.utf8))
    let state = OverlayState.shared
    state.selectTab(.tasks)
    state.clearBriefContext()
    let before = state.composerFocusRequest

    state.chatAbout(question)

    XCTAssertEqual(state.tab, .supervisor)
    XCTAssertGreaterThan(state.composerFocusRequest, before)
    let json = state.fleetContext?.jsonObject
    XCTAssertEqual(json?["kind"] as? String, "fleet")
    XCTAssertEqual((json?["entityRef"] as? [String: String])?["kind"], "fleet")
    XCTAssertEqual((json?["entityRef"] as? [String: String])?["id"], "fq_9")
    XCTAssertEqual(state.activeContext?.entityRef?.id, "fq_9")

    state.selectTab(.tasks)
    XCTAssertNil(state.activeContext, "the Tasks tab shows its own context, not the supervisor's")
    state.selectTab(.supervisor)
    XCTAssertEqual(state.activeContext?.entityRef?.id, "fq_9")

    state.pruneFleetContext(openIDs: ["fq_other"])
    XCTAssertNil(state.fleetContext, "a closed question stops being the ask's subject")
    state.selectTab(.tasks)
  }

  func testFleetOverviewHasNoEntityRef() {
    let overview = BriefChatContext.fleetOverview
    XCTAssertEqual(overview.kind, "fleet")
    XCTAssertNil(overview.entityRef)
    XCTAssertNil(overview.jsonObject["entityRef"])
  }

  func testTasksAndSupervisorUseDifferentSessions() {
    XCTAssertEqual(AppState.overlayTasksSessionId, "overlay:user:main")
    XCTAssertEqual(AppState.overlaySupervisorSessionId, "overlay:supervisor:main")
    XCTAssertNotEqual(AppState.overlayTasksSessionId, AppState.overlaySupervisorSessionId)
  }
}
