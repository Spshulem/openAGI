import AppKit
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
    XCTAssertEqual(state.mode, "")
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

  /// The hub's outcome decides the line: four answers, four lines.
  func testOutcomeFieldDecidesTheLine() throws {
    typealias R = FleetQuestionResponse
    func line(_ json: String) throws -> (text: String, isError: Bool) {
      let delivery = try JSONDecoder().decode(FleetDelivery.self, from: Data(json.utf8))
      return FleetConsumer.outcome(R(question: .init(id: "q", status: "open"), delivery: delivery, state: nil), dismissed: false)
    }
    let delivered = try line(#"{"status":"sent","outcome":"delivered"}"#)
    XCTAssertEqual(delivered.text, "Sent to the agent.")
    XCTAssertFalse(delivered.isError)
    let queued = try line(#"{"status":"queued","outcome":"queued","detail":"Saved. It goes to the agent once the Mac can type (secure input is on)."}"#)
    XCTAssertEqual(queued.text, "Saved. It goes to the agent once the Mac can type (secure input is on).", "the hub's reason for waiting stands")
    XCTAssertFalse(queued.isError)
    let ambiguous = try line(#"{"status":"blocked","unconfirmed":true,"outcome":"ambiguous","detail":"turn confirmation timed out"}"#)
    XCTAssertEqual(ambiguous.text, "May have reached the agent; not confirmed yet. Not sent again: check the chat before answering again.")
    XCTAssertTrue(ambiguous.isError)
    let refused = try line(#"{"status":"blocked","outcome":"refused","detail":"the chat is archived; nothing was sent"}"#)
    XCTAssertEqual(refused.text, "Not sent: the chat is archived; nothing was sent")
    XCTAssertTrue(refused.isError)
    XCTAssertEqual(FleetThreadOutcome.reply(FleetDelivery(status: "queued", detail: nil, outcome: "queued")).text,
                   "Queued. It goes to the agent as soon as it can take it.")
  }

  func testStatusLine() {
    let now = ISO8601DateFormatter().date(from: "2026-09-29T10:04:00Z")!
    let status = FleetStatus(mode: "propose", enabled: true, running: false,
                             lastTickAt: "2026-09-29T10:00:00.000Z", lastError: nil)
    XCTAssertEqual(FleetConsumer.statusLine(status, now: now), "Scanned 4m ago · Propose mode")

    let never = FleetStatus(mode: "observe", enabled: false, running: false, lastTickAt: nil, lastError: nil)
    XCTAssertEqual(FleetConsumer.statusLine(never, now: now), "Not scanned yet · Observe mode · auto-scan off")

    let running = FleetStatus(mode: "auto", enabled: true, running: true,
                              lastTickAt: "2026-09-29T09:00:00.000Z", lastError: nil)
    XCTAssertEqual(FleetConsumer.statusLine(running, now: now), "Scanning now · Auto mode")
  }

  func testQuestionAge() {
    let now = ISO8601DateFormatter().date(from: "2026-09-29T10:04:00Z")!
    XCTAssertEqual(FleetConsumer.age("2026-09-29T10:03:30.000Z", now: now), "now")
    XCTAssertEqual(FleetConsumer.age("2026-09-29T09:52:00Z", now: now), "12m")
    XCTAssertEqual(FleetConsumer.age("2026-09-29T07:00:00Z", now: now), "3h")
    XCTAssertEqual(FleetConsumer.age("2026-09-27T10:00:00Z", now: now), "2d")
    XCTAssertNil(FleetConsumer.age(nil, now: now))
    XCTAssertNil(FleetConsumer.age("yesterday", now: now))
  }

  func testOptionLabelsAndOpenThread() throws {
    let fixed = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_4","kind":"stuck","title":"Stuck","options":["keep going","on it","open thread"]}
      """.utf8))
    XCTAssertEqual(fixed.tappableOptions, ["keep going", "on it"], "open thread is a hint, not a button")
    XCTAssertTrue(fixed.answersInThread)
    XCTAssertEqual(fixed.label(for: "on it"), "On it")

    let agent = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_5","kind":"agent-ask","title":"Which branch?","options":["main","release"]}
      """.utf8))
    XCTAssertEqual(agent.label(for: "main"), "main", "the agent's own choices stay as written")
    XCTAssertFalse(agent.answersInThread)

    let sealed = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_6","kind":"agent-ask","title":"Sealed","options":["open thread"]}
      """.utf8))
    XCTAssertEqual(sealed.tappableOptions, [])
    XCTAssertTrue(sealed.answersInThread)
  }

  func testOutreachItemDecodesSourceRef() throws {
    let item = try JSONDecoder().decode(OutreachItem.self, from: Data("""
      {"id":"o1","seq":4,"type":"fleet-question","title":"t","sourceRef":{"kind":"fleet","id":"fq_1","nodeId":"mac"}}
      """.utf8))
    XCTAssertEqual(item.sourceKind, "fleet")
    XCTAssertEqual(item.sourceId, "fq_1")
    let bare = try JSONDecoder().decode(OutreachItem.self, from: Data("""
      {"id":"o2","type":"draft","sourceRef":"not an object"}
      """.utf8))
    XCTAssertNil(bare.sourceKind)
    XCTAssertNil(bare.sourceId)
  }

  func testOnlyLocalQuestionsLeaveTheTasksTab() throws {
    func item(_ json: String) throws -> OutreachItem {
      try JSONDecoder().decode(OutreachItem.self, from: Data(json.utf8))
    }
    let mine = try item(#"{"id":"o1","type":"fleet-question","sourceRef":{"kind":"fleet","id":"fq_1","nodeId":"mac"}}"#)
    let otherNode = try item(#"{"id":"o2","type":"fleet-question","sourceRef":{"kind":"fleet","id":"fq_9"}}"#)
    let noRef = try item(#"{"id":"o3","type":"fleet-question"}"#)
    let draft = try item(#"{"id":"o4","type":"draft"}"#)
    let approval = try item(#"{"id":"o5","type":"pending-action"}"#)
    let open: Set<String> = ["fq_1"]

    XCTAssertTrue(FleetConsumer.lists(mine, available: true, openIDs: open))
    XCTAssertFalse(FleetConsumer.lists(otherNode, available: true, openIDs: open), "another node's question stays on Tasks")
    XCTAssertFalse(FleetConsumer.lists(noRef, available: true, openIDs: open))
    XCTAssertFalse(FleetConsumer.lists(mine, available: false, openIDs: open), "no Supervisor tab, nothing hidden")

    XCTAssertEqual(FleetConsumer.tab(showing: [mine], available: true, openIDs: open), .supervisor)
    XCTAssertEqual(FleetConsumer.tab(showing: [mine, approval], available: true, openIDs: open), .supervisor)
    XCTAssertEqual(FleetConsumer.tab(showing: [mine, draft], available: true, openIDs: open), .tasks)
    XCTAssertEqual(FleetConsumer.tab(showing: [otherNode], available: true, openIDs: open), .tasks)
    XCTAssertEqual(FleetConsumer.tab(showing: [approval], available: true, openIDs: open), .tasks)
    XCTAssertEqual(FleetConsumer.tab(showing: [], available: true, openIDs: open), .tasks)
  }

  func testFleetSendMessageApprovalShowsTheWholeMessage() throws {
    let message = String(repeating: "Do the thing. ", count: 60) + "LAST WORDS"
    let approval = try JSONDecoder().decode(PendingApproval.self, from: JSONSerialization.data(withJSONObject: [
      "id": "pa_1", "toolName": "fleet_send_message", "status": "pending",
      "summary": String(("Send to amman (codex:t1):\n" + message).prefix(240)),
      "args": ["key": "codex:t1", "message": message, "name": "amman"]
    ]))
    XCTAssertEqual(approval.fleetMessage?.message, message)
    XCTAssertTrue(approval.reviewText?.hasSuffix("LAST WORDS") == true)
    XCTAssertTrue(approval.reviewText?.hasPrefix("To amman (codex:t1)") == true)
    XCTAssertFalse(approval.needsDashboardReview)

    let undecodable = try JSONDecoder().decode(PendingApproval.self, from: JSONSerialization.data(withJSONObject: [
      "id": "pa_2", "toolName": "fleet_send_message", "status": "pending", "args": ["key": 7]
    ]))
    XCTAssertNil(undecodable.reviewText)
    XCTAssertTrue(undecodable.needsDashboardReview, "no full text, no Approve in the panel")
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

  func testSharedSupervisorPayloadExcludesUnsupportedNodeFields() {
    let allowed: Set<String> = ["text", "from", "sessionId", "thread", "conversationId", "attachments", "focusedCardId"]

    let plain = SharedSupervisorClient.buildMessagePayload(text: "Hello")
    XCTAssertTrue(Set(plain.keys).isSubset(of: allowed))
    XCTAssertNil(plain["metadata"])
    XCTAssertNil(plain["channel"])
    XCTAssertNil(plain["agentId"])
    XCTAssertEqual(plain["thread"] as? String, "supervisor")
    XCTAssertEqual(plain["from"] as? String, "mac-supervisor")

    let img = NSImage(size: NSSize(width: 24, height: 24), flipped: false) { rect in
      NSColor.systemBlue.setFill()
      rect.fill()
      return true
    }
    let att = WorkspaceImageAttachment.encode(img, name: "snap.png")
    XCTAssertNotNil(att)

    let withCardAndPhoto = SharedSupervisorClient.buildMessagePayload(
      text: "Inspect",
      focusedCardId: "card:paseo_1",
      attachments: att.map { [$0] } ?? []
    )
    XCTAssertTrue(Set(withCardAndPhoto.keys).isSubset(of: allowed))
    XCTAssertEqual(withCardAndPhoto["focusedCardId"] as? String, "card:paseo_1")
    XCTAssertEqual((withCardAndPhoto["attachments"] as? [[String: Any]])?.count, 1)

    let badCard = SharedSupervisorClient.buildMessagePayload(text: "Hi", focusedCardId: "bad id with spaces")
    XCTAssertNil(badCard["focusedCardId"])

    let fallback = SharedSupervisorClient.buildMessagePayload(
      text: "Hi",
      focusedCardId: "card_1",
      includeThread: false,
      includeFocusedCard: false
    )
    XCTAssertNil(fallback["thread"])
    XCTAssertNil(fallback["focusedCardId"])
  }

  func testAppStateExtractErrorMessageAndWorkerFallbackPayload() {
    let errData = Data(#"{"error":"node message contains unsupported fields"}"#.utf8)
    XCTAssertEqual(AppState.extractErrorMessage(errData), "node message contains unsupported fields")

    let msgData = Data(#"{"error":"invalid_images","message":"Use JPEG, PNG or WebP images."}"#.utf8)
    XCTAssertEqual(AppState.extractErrorMessage(msgData), "Use JPEG, PNG or WebP images.")

    let fallback = AppState.workerFallbackOverlayPayload(
      text: "What's on screen?",
      sessionId: AppState.overlayTasksSessionId,
      screenContext: ScreenContext(app: "Xcode", window: "OpenAGI.swift", text: "build succeeded"),
      briefContext: nil
    )
    XCTAssertEqual(fallback["thread"] as? String, "agent")
    XCTAssertEqual(fallback["from"] as? String, "mac-overlay")
    XCTAssertNil(fallback["metadata"])
    XCTAssertNil(fallback["channel"])
    XCTAssertTrue((fallback["text"] as? String ?? "").contains("Xcode"))
  }

  func testSyncedSupervisorMessageDecodesServerAttachmentThumbnail() throws {
    let thumbBytes = Data([0xff, 0xd8, 0xff, 0xd9])
    let json = """
      {
        "id": "m1",
        "role": "user",
        "text": "See screenshot",
        "at": "2026-11-18T22:00:00Z",
        "sourceName": "Mac",
        "sourceNodeId": null,
        "attachments": [{"id": "a1", "name": "snap.jpg", "mimeType": "image/jpeg", "thumbnail": "\(thumbBytes.base64EncodedString())"}]
      }
      """
    let decoded = try JSONDecoder().decode(SyncedSupervisorMessage.self, from: Data(json.utf8))
    XCTAssertEqual(decoded.thumbnailImageData, [thumbBytes])
  }

  func testWorkspaceMarkdownParserAndModelOptionsAndDockDefault() throws {
    let md = """
      # Status Summary
      All **tests** passed cleanly.
      - Item one
      - Item two
      1. First step
      2. Second step
      ```swift
      print("ok")
      ```
      """
    let blocks = WorkspaceMarkdownParser.parse(md)
    XCTAssertEqual(blocks.count, 5)
    XCTAssertEqual(blocks[0], .heading(level: 1, text: "Status Summary"))
    XCTAssertEqual(blocks[1], .paragraph("All **tests** passed cleanly."))
    XCTAssertEqual(blocks[2], .bulletList(["Item one", "Item two"]))
    XCTAssertEqual(blocks[3], .numberedList(["First step", "Second step"]))
    XCTAssertEqual(blocks[4], .codeBlock(language: "swift", code: "print(\"ok\")"))

    XCTAssertEqual(MacModelOption.displayName(for: "gpt-6.2-sol"), "GPT-6.2 Sol")
    XCTAssertEqual(MacModelOption.displayName(for: "custom-model"), "custom-model")
    XCTAssertEqual(MacModelOption.displayName(for: nil), "Model")

    let suiteName = "FleetOverlayTests.dock.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    XCTAssertTrue(AppState.defaultShowsInDock(defaults: defaults))
    defaults.set(false, forKey: AppState.showsInDockDefaultsKey)
    XCTAssertFalse(AppState.defaultShowsInDock(defaults: defaults))
  }

  func testFleetSingleCardPagerAndWatchingCollapsedByDefault() throws {
    let fleet = FleetConsumer()
    XCTAssertFalse(fleet.watchingExpanded)
    XCTAssertEqual(fleet.currentQuestionIndex, 0)
    fleet.stepQuestion(1)
    XCTAssertEqual(fleet.currentQuestionIndex, 0)

    let threeQuestions = try JSONDecoder().decode(FleetState.self, from: Data("""
      {
        "mode": "propose",
        "enabled": true,
        "running": false,
        "questions": [
          {"id": "q1", "title": "First", "body": "", "options": ["yes"]},
          {"id": "q2", "title": "Second", "body": "", "options": ["yes"]},
          {"id": "q3", "title": "Third", "body": "", "options": ["yes"]}
        ]
      }
      """.utf8))
    fleet.apply(threeQuestions)
    XCTAssertEqual(fleet.currentQuestionIndex, 0)
    fleet.stepQuestion(1)
    XCTAssertEqual(fleet.currentQuestionIndex, 1)
    fleet.stepQuestion(-2)
    XCTAssertEqual(fleet.currentQuestionIndex, 2)

    let oneQuestion = try JSONDecoder().decode(FleetState.self, from: Data("""
      {
        "mode": "propose",
        "enabled": true,
        "running": false,
        "questions": [{"id": "q1", "title": "Only", "body": "", "options": ["yes"]}]
      }
      """.utf8))
    fleet.apply(oneQuestion)
    XCTAssertEqual(fleet.currentQuestionIndex, 0)

    fleet.toggleWatchingExpanded()
    XCTAssertTrue(fleet.watchingExpanded)
    fleet.supervisorTabLeft()
    XCTAssertFalse(fleet.watchingExpanded)

    let approvals = PendingApprovalConsumer()
    XCTAssertFalse(approvals.overlayExpanded)
    approvals.toggleOverlayExpanded()
    XCTAssertTrue(approvals.overlayExpanded)
  }
}
