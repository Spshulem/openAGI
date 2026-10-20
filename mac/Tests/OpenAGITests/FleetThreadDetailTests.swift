import Foundation
import XCTest
@testable import OpenAGI

/// Open chat, the opened row's lines, Push now and Mute results, and the
/// question card's new fields (src/fleet/supervisor.js questionView,
/// threadDetail; contracts.js openChatFor).
@MainActor
final class FleetThreadDetailTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  private let now = FleetWatching.parseDate("2026-10-14T04:00:00Z")!

  // MARK: - Questions

  func testQuestionCarriesChatAskTimeAndRisk() throws {
    let question = try decode(FleetQuestion.self, """
      {"id":"fq_4","kind":"agent-ask","title":"Which BuildBot3 capacity fix should be applied?",
       "options":["A","B","open thread"],"threadKey":"conductor:d1dbe71a","createdAt":"2026-10-14T01:00:00Z",
       "askedAt":"2026-10-14T00:21:00Z","chatLabel":"remote-dev · Codex LB Transcript open (Conductor)",
       "answerIn":"here","risky":true,"askContext":"Pick A or B.",
       "openChat":{"app":"conductor","url":"conductor://workspace?id=w1&session=s1",
                   "label":"remote-dev · Codex LB Transcript open (Conductor)","note":null}}
      """)
    XCTAssertEqual(question.askedTime, "2026-10-14T00:21:00Z")
    XCTAssertTrue(question.risky)
    XCTAssertFalse(question.answersInThread, "answerIn wins over the open-thread option")
    XCTAssertEqual(question.openChat?.link?.absoluteString, "conductor://workspace?id=w1&session=s1")
    XCTAssertEqual(SupervisorSection.placeLine(question, now: now),
                   "In remote-dev · Codex LB Transcript open (Conductor) · asked 4h ago")
  }

  func testOldDaemonQuestionFallsBack() throws {
    let question = try decode(FleetQuestion.self, """
      {"id":"fq_5","title":"Old","options":["open thread"],"createdAt":"2026-10-14T03:00:00Z"}
      """)
    XCTAssertFalse(question.risky)
    XCTAssertTrue(question.answersInThread)
    XCTAssertEqual(question.askedTime, "2026-10-14T03:00:00Z")
    XCTAssertNil(question.openChat)
    XCTAssertEqual(question.allChats, [])
    XCTAssertEqual(SupervisorSection.placeLine(question, now: now), "Asked 1h ago")
  }

  func testAgentAppQuestionAndGroupedChats() throws {
    let question = try decode(FleetQuestion.self, """
      {"id":"fq_6","title":"2 stopped","options":["done"],"answerIn":"agent app",
       "chats":[{"threadKey":"codex:a","app":"codex","url":"codex://threads/a","label":"A (Codex)"},
                {"threadKey":"claude:b","app":"claude","url":null,"label":"repo · B (Claude Code)","note":"terminal"},
                {"label":""}]}
      """)
    XCTAssertTrue(question.answersInThread)
    XCTAssertEqual(question.chats.map(\.label), ["A (Codex)", "repo · B (Claude Code)"], "a chat with no label is dropped")
    XCTAssertEqual(question.allChats.first?.threadKey, "codex:a")
  }

  // MARK: - Open chat

  func testOpenChatOnlyOpensTheAppSchemes() {
    let conductor = FleetOpenChat(app: "conductor", url: "conductor://workspace?id=w&session=s", label: "w (Conductor)")
    XCTAssertEqual(FleetChatOpener.target(conductor), .link(URL(string: "conductor://workspace?id=w&session=s")!))
    XCTAssertEqual(FleetChatOpener.buttonTitle(conductor), "Open chat")

    let codex = FleetOpenChat(app: "codex", url: "codex://threads/01a13388", label: "Amex (Codex)")
    XCTAssertEqual(FleetChatOpener.buttonTitle(codex), "Open chat")

    // A daemon string is never opened as a web or file link.
    let web = FleetOpenChat(app: "codex", url: "https://example.com", label: "x (Codex)")
    XCTAssertNil(web.link)
    XCTAssertEqual(FleetChatOpener.target(web), .app(bundleIdentifier: "com.openai.codex", name: "Codex"))

    let noLink = FleetOpenChat(app: "conductor", url: nil, label: "ws · tab (Conductor)", note: "open it from the sidebar")
    XCTAssertEqual(FleetChatOpener.buttonTitle(noLink), "Open Conductor")

    let claude = FleetOpenChat(app: "claude", url: nil, label: "repo · s (Claude Code)", note: "terminal")
    XCTAssertEqual(FleetChatOpener.target(claude), .nowhere)
    XCTAssertNil(FleetChatOpener.buttonTitle(claude))
  }

  func testAntigravityHasGuidanceWithoutAConversationLink() {
    let chat = FleetOpenChat(app: "antigravity", url: nil, label: "api · Auth (Antigravity)", note: "Open it in Antigravity.")
    XCTAssertEqual(chat.appName, "Antigravity")
    XCTAssertNil(chat.link)
    XCTAssertEqual(FleetChatOpener.target(chat), .nowhere)
    XCTAssertEqual(FleetConsumer.threadPath("antigravity:a1"), "/fleet/api/threads/antigravity%3Aa1")
  }

  func testThreadPathEncodesTheColon() {
    XCTAssertEqual(FleetConsumer.threadPath("conductor:d1dbe71a"), "/fleet/api/threads/conductor%3Ad1dbe71a")
  }

  // MARK: - Rows

  func testThreadRowDecodesNewFields() throws {
    let state = try decode(FleetState.self, """
      {"snapshot":{"threads":[{"key":"codex:01a13388","title":"Download Amex Statements",
        "watch":{"group":"push","since":"2026-10-14T03:00:00Z","otherwise":{"group":"push","waitingOn":null}},
        "muted":"2026-10-15T04:00:00Z","lastOwnerAt":"2026-10-14T02:00:00Z","lastAgentText":"Done downloading.",
        "openChat":{"app":"codex","url":"codex://threads/01a13388","label":"Download Amex Statements (Codex)"},
        "pushPreview":{"action":"nudge","message":"Please finish."},"pushing":true,
        "decision":{"action":"nudge","playbook":"stopped","reason":"stopped with work left","message":"Please finish."},
        "pr":{"ref":"o/r#12","url":"https://github.com/o/r/pull/12","state":"OPEN","ci":{"state":"failure","failing":["lint",3]},"unresolvedThreads":2}}]}}
      """)
    let row = try XCTUnwrap(state.threads.first)
    XCTAssertEqual(row.watch?.otherwiseGroup, "push")
    XCTAssertEqual(row.openChat?.link?.absoluteString, "codex://threads/01a13388")
    XCTAssertEqual(row.decision?.message, "Please finish.")
    XCTAssertEqual(row.pr?.ci?.failing, ["lint"])
    XCTAssertEqual(row.prRef, "o/r#12")

    let summary = FleetThreadSummary(thread: row, detail: nil, now: now)
    XCTAssertEqual(summary.excerpt, "Done downloading.", "the current server redacts row text before delivery")
    XCTAssertEqual(summary.prLine, "r#12 · open · CI failing: lint · 2 unresolved")
    XCTAssertEqual(summary.prLink?.absoluteString, "https://github.com/o/r/pull/12")
    XCTAssertEqual(summary.waitLine, "Stopped for 1h; the supervisor pushes it")
    XCTAssertEqual(summary.nextLine, "Next: nudge the agent. stopped with work left")
    XCTAssertEqual(summary.pushMessage, "Please finish.")
    XCTAssertTrue(summary.muted)
    XCTAssertNotNil(summary.mutedLine)
    XCTAssertEqual(summary.ownerLine, "You last wrote 2h ago")
  }

  func testDetailAddsTheLongerMessageButTheRowKeepsTheLiveWatch() throws {
    let detail = try XCTUnwrap(FleetThreadDetail.decodeResponse(Data("""
      {"thread":{"key":"codex:t","lastAgentMessage":{"text":"The longer, redacted words.","at":"2026-10-14T03:30:00Z"},
        "watch":{"group":"you","since":"2026-10-13T19:38:00Z","waitingOn":"your answer"},
        "blockers":["unpushed commits",4],"muted":null,"decision":{"action":"wait","reason":"cooldown","notBefore":"bad"}}}
      """.utf8)))
    XCTAssertEqual(detail.blockers, ["unpushed commits"])
    let row = FleetThread(key: "codex:t", lastAgentAt: "2026-10-14T01:00:00Z",
                          watch: FleetWatch(group: "push", since: "2026-10-14T03:00:00Z"),
                          lastAgentText: "short")
    let summary = FleetThreadSummary(thread: row, detail: detail, now: now)
    XCTAssertEqual(summary.excerpt, "The longer, redacted words.")
    XCTAssertEqual(summary.excerptAge, "30m ago")
    // The dismissed question's "you" in a stale detail never wins over the live row.
    XCTAssertEqual(summary.waitLine, "Stopped for 1h; the supervisor pushes it")

    // A thread the row list doesn't have: the detail stands in.
    let alone = FleetThreadSummary(thread: nil, detail: detail, now: now)
    XCTAssertEqual(alone.waitLine, "Waits on your answer for 8h")
    XCTAssertEqual(alone.nextLine, "Next: wait. cooldown")
  }

  func testWaitAndNextLines() {
    let waiting = FleetWatch(group: "waiting", since: "2026-10-14T02:00:00Z", waitingOn: "BuildBot3 full run",
                             waitSince: "2026-10-14T03:37:00Z")
    XCTAssertEqual(FleetThreadSummary.waitLine(waiting, now: now), "Waits on BuildBot3 full run for 23m")
    XCTAssertEqual(FleetThreadSummary.nextLine(FleetDecision(action: "ask-user", reason: "agent asked"), now: now),
                   "Next: ask you. agent asked")
    XCTAssertNil(FleetThreadSummary.nextLine(FleetDecision(action: nil), now: now))
    XCTAssertEqual(FleetThreadSummary.tail("abcdef", 4), "\u{2026}def")
  }

  // MARK: - Push now and Mute

  func testPushOutcomes() throws {
    XCTAssertEqual(FleetThreadOutcome.push(FleetDelivery(status: "sent", detail: nil)),
                   FleetNote(text: "Pushed. Sent to the agent.", isError: false))
    XCTAssertEqual(FleetThreadOutcome.push(FleetDelivery(status: "blocked", detail: "waits on your answer first: Which?")),
                   FleetNote(text: "Not sent: waits on your answer first: Which?", isError: true))
    XCTAssertTrue(FleetThreadOutcome.push(FleetDelivery(status: "failed", detail: nil)).isError)
    XCTAssertTrue(FleetThreadOutcome.push(nil).isError)

    let response = try decode(FleetThreadActionResponse.self, """
      {"delivery":{"status":"blocked","route":null,"detail":"muted: unmute it to push"},"action":null,"state":{"mode":"auto"}}
      """)
    XCTAssertEqual(response.delivery?.detail, "muted: unmute it to push")
    XCTAssertEqual(response.state?.mode, "auto")
  }

  func testMuteOutcomes() {
    XCTAssertEqual(FleetThreadOutcome.muted(nil).text, "Unmuted.")
    XCTAssertTrue(FleetThreadOutcome.muted("2026-10-15T04:00:00Z", now: now).text.hasPrefix("Muted until "))
  }

  // MARK: - Connection lost

  func testDroppedAskIsReadBackByRequestId() {
    let session = Data("""
      {"id":"overlay:user:main","messages":[
        {"role":"user","content":"q","metadata":{"requestId":"ask_1"}},
        {"role":"assistant","content":"old answer","metadata":{"requestId":"ask_0"}},
        {"role":"assistant","content":"the answer","metadata":{"requestId":"ask_1"}},
        {"role":"user","content":"q2","metadata":{"requestId":"ask_2"}},
        {"role":"assistant","content":"I couldn't complete that request: x","metadata":{"requestId":"ask_3","status":"failed"}}]}
      """.utf8)
    XCTAssertEqual(AppState.overlayReply(in: session, requestId: "ask_1"), .answered("the answer"))
    XCTAssertNil(AppState.overlayReply(in: session, requestId: "ask_2"), "still running: only the user turn is saved")
    XCTAssertEqual(AppState.overlayReply(in: session, requestId: "ask_3"), .failed("I couldn't complete that request: x"))
    XCTAssertNil(AppState.overlayReply(in: Data("{}".utf8), requestId: "ask_1"))
  }
  func testPushPreviewWinsOverAutomaticDecisionAndClearsWithLiveRow() throws {
    let row = try decode(FleetThread.self, """
      {"key":"codex:t","watch":{"group":"push"},"decision":{"action":"wait","reason":"cooldown"},
       "pushPreview":{"action":"nudge","message":"The approved words"},"pushing":true}
      """)
    XCTAssertEqual(FleetThreadSummary(thread: row, detail: nil).pushMessage, "The approved words")
    XCTAssertTrue(row.pushing)
    let cleared = FleetThread(key: row.key, watch: row.watch)
    let stale = FleetThreadDetail(key: row.key, pushPreview: FleetDecision(action: "nudge", message: "Stale words"))
    XCTAssertNil(FleetThreadSummary(thread: cleared, detail: stale).pushMessage)
  }

  func testRiskyAskContextKeepsEveryWordBeforeAnAnswer() throws {
    let context = String(repeating: "Release details. ", count: 100) + "THE END"
    let data = try JSONSerialization.data(withJSONObject: ["id": "q", "title": "Release?", "risky": true, "askContext": context])
    let q = try JSONDecoder().decode(FleetQuestion.self, from: data)
    XCTAssertEqual(q.displayAskContext, context)
  }

  func testUnreachableDaemonDoesNotClaimTheAskIsRunning() {
    for code in [NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorNotConnectedToInternet] {
      XCTAssertFalse(AppState.requestMayStillBeRunning(after: NSError(domain: NSURLErrorDomain, code: code)))
    }
    XCTAssertTrue(AppState.requestMayStillBeRunning(after: NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)))
  }

  func testDetailLoadInFlightKeepsOneFollowUpForTheNewScan() async throws {
    let started = expectation(description: "first detail request started")
    var release: CheckedContinuation<Void, Never>?
    var reads = 0
    let consumer = FleetConsumer(fetchDetail: { request in
      reads += 1
      let read = reads
      if read == 1 {
        await withCheckedContinuation { continuation in
          release = continuation
          started.fulfill()
        }
      }
      let text = read == 1 ? "Before scan" : "After scan"
      let data = Data("{\"thread\":{\"key\":\"codex:t\",\"lastAgentMessage\":{\"text\":\"\(text)\"}}}".utf8)
      return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    })
    let first = Task { await consumer.loadDetail("codex:t") }
    await fulfillment(of: [started], timeout: 2)
    await consumer.loadDetail("codex:t")
    await consumer.loadDetail("codex:t")
    XCTAssertEqual(reads, 1, "overlapping reads coalesce")
    release?.resume()
    await first.value
    XCTAssertEqual(reads, 2)
    XCTAssertEqual(consumer.details["codex:t"]?.lastAgentText, "After scan")
    XCTAssertFalse(consumer.detailLoading.contains("codex:t"))
  }

  func testNewerRowWinsOverCachedDetailTextAndOwnerTime() throws {
    let detail = try XCTUnwrap(FleetThreadDetail.decodeResponse(Data("""
      {"thread":{"key":"codex:t","lastOwnerAt":"2026-10-14T01:00:00Z",
        "lastAgentMessage":{"text":"Old detail","at":"2026-10-14T02:00:00Z"}}}
      """.utf8)))
    let row = FleetThread(key: "codex:t", lastAgentAt: "2026-10-14T03:30:00Z", watch: nil,
                          lastAgentText: "New row", lastOwnerAt: "2026-10-14T03:00:00Z")
    let summary = FleetThreadSummary(thread: row, detail: detail, now: now)
    XCTAssertEqual(summary.excerpt, "New row")
    XCTAssertEqual(summary.excerptAge, "30m ago")
    XCTAssertEqual(summary.ownerLine, "You last wrote 1h ago")
  }

  func testLegacyGroupedQuestionRetainsThreadKeys() throws {
    let question = try decode(FleetQuestion.self, """
      {"id":"legacy-group","threadKeys":["codex:a","claude:b"]}
      """)
    XCTAssertEqual(question.threadKeys, ["codex:a", "claude:b"])
  }

}
