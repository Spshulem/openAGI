import XCTest
@testable import OpenAGI

/// The Supervisor detail screen: the chat's decoding, which item is open,
/// and where a typed reply goes.
@MainActor
final class FleetDrillDownTests: XCTestCase {
  private func decodeQuestion(_ json: String) throws -> FleetQuestion {
    try JSONDecoder().decode(FleetQuestion.self, from: Data(json.utf8))
  }

  private func response(_ request: URLRequest, _ code: Int, _ body: String) -> (Data, URLResponse) {
    (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
  }

  private func jsonBody(_ request: URLRequest) -> [String: Any] {
    (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
  }

  // MARK: - Decoding

  func testConversationDecodesLossily() throws {
    let json = """
    {"thread":{"key":"codex:t","conversation":{"truncated":true,"unavailableReason":"  ","messages":[
      {"id":"a","role":"user","text":" Ship it? ","at":"2026-11-10T10:00:00Z"},
      {"id":"b","role":"assistant","text":""},
      {"role":7,"text":"No id, odd role"},
      {"id":"a","role":"assistant","text":"Repeated id"},
      {"id":"c","role":"assistant"},
      "junk",
      {"id":"d","role":"assistant","text":"Done.","at":42}
    ]}}}
    """
    let detail = try XCTUnwrap(FleetThreadDetail.decodeResponse(Data(json.utf8)))
    let conversation = try XCTUnwrap(detail.conversation)
    XCTAssertTrue(conversation.truncated)
    XCTAssertNil(conversation.unavailableReason, "a blank reason is no reason")
    XCTAssertEqual(conversation.messages.map(\.text), ["Ship it?", "No id, odd role", "Repeated id", "Done."])
    XCTAssertEqual(conversation.messages.map(\.speaker), ["You", "Agent", "Agent", "Agent"])
    XCTAssertEqual(Set(conversation.messages.map(\.id)).count, 4, "ids stay unique list keys")
    XCTAssertEqual(conversation.messages.first?.at, "2026-11-10T10:00:00Z")
    XCTAssertNil(conversation.messages.last?.at)
  }

  func testOlderHubHasNoConversationAndABadOneCostsOnlyIt() throws {
    let old = try XCTUnwrap(FleetThreadDetail.decodeResponse(Data(#"{"thread":{"key":"k","title":"T"}}"#.utf8)))
    XCTAssertNil(old.conversation)
    let bad = try XCTUnwrap(FleetThreadDetail.decodeResponse(Data(#"{"thread":{"key":"k","title":"T","conversation":"x"}}"#.utf8)))
    XCTAssertNil(bad.conversation)
    XCTAssertEqual(bad.title, "T")
    let reason = try XCTUnwrap(FleetThreadDetail.decodeResponse(Data(
      #"{"thread":{"key":"k","conversation":{"messages":"nope","truncated":"yes","unavailableReason":"Only the last exchange."}}}"#.utf8)))
    XCTAssertEqual(reason.conversation?.messages, [])
    XCTAssertEqual(reason.conversation?.truncated, false)
    XCTAssertEqual(reason.conversation?.unavailableReason, "Only the last exchange.")
  }

  func testCanReplyDefaultsToFalse() throws {
    XCTAssertFalse(try decodeQuestion(#"{"id":"q1"}"#).canReply)
    XCTAssertFalse(try decodeQuestion(#"{"id":"q1","canReply":"yes"}"#).canReply)
    XCTAssertTrue(try decodeQuestion(#"{"id":"q1","canReply":true}"#).canReply)
  }

  // MARK: - Reply target

  func testReplyTarget() throws {
    let replyable = try decodeQuestion(#"{"id":"q1","kind":"agent-ask","threadKey":"codex:a","canReply":true,"risky":true}"#)
    XCTAssertEqual(FleetReplyTarget.of(replyable), .question(id: "q1"))

    let olderHub = try decodeQuestion(#"{"id":"q2","kind":"agent-ask","threadKey":"codex:a"}"#)
    XCTAssertEqual(FleetReplyTarget.of(olderHub), .thread(key: "codex:a"))

    let riskyOlderHub = try decodeQuestion(#"{"id":"q3","kind":"agent-ask","threadKey":"codex:a","risky":true}"#)
    XCTAssertFalse(FleetReplyTarget.of(riskyOlderHub).canSend, "a risky reply only goes through the question route")

    let card = try decodeQuestion(#"{"id":"q4","kind":"agent-card","threadKey":"conductor:a","openChat":{"app":"conductor","label":"ws"}}"#)
    XCTAssertEqual(FleetReplyTarget.of(card), .none(why: "Answer it in Conductor."))

    let grouped = try decodeQuestion(#"{"id":"q5","kind":"stuck","threadKeys":["a","b"],"chats":[{"label":"A","threadKey":"a"},{"label":"B","threadKey":"b"}]}"#)
    XCTAssertFalse(FleetReplyTarget.of(grouped).canSend)

    XCTAssertEqual(FleetReplyTarget.of(threadKey: "codex:z"), .thread(key: "codex:z"))
  }

  func testReplyMessageBounds() {
    XCTAssertEqual(FleetReplyTarget.message("  use main \n"), "use main")
    XCTAssertNil(FleetReplyTarget.message(" \n "))
    XCTAssertNotNil(FleetReplyTarget.message(String(repeating: "a", count: 2000)))
    XCTAssertNil(FleetReplyTarget.message(String(repeating: "a", count: 2001)))
  }

  // MARK: - Open and close

  func testReconcileKeepsOpenItemsAndFallsBackToTheThread() throws {
    let question = try decodeQuestion(#"{"id":"q1","threadKey":"codex:a"}"#)
    XCTAssertEqual(FleetOpenItem.reconcile(.question("q1"), closedQuestion: nil, openIDs: ["q1"], threadKeys: []), .question("q1"))
    XCTAssertEqual(FleetOpenItem.reconcile(.question("q1"), closedQuestion: question, openIDs: [], threadKeys: ["codex:a"]), .thread("codex:a"))
    XCTAssertNil(FleetOpenItem.reconcile(.question("q1"), closedQuestion: question, openIDs: [], threadKeys: ["codex:b"]))
    XCTAssertEqual(FleetOpenItem.reconcile(.thread("codex:a"), closedQuestion: nil, openIDs: [], threadKeys: ["codex:a"]), .thread("codex:a"))
    XCTAssertNil(FleetOpenItem.reconcile(.thread("codex:a"), closedQuestion: nil, openIDs: [], threadKeys: []))
    XCTAssertNil(FleetOpenItem.reconcile(nil, closedQuestion: nil, openIDs: ["q1"], threadKeys: ["codex:a"]))
    XCTAssertNotEqual(FleetOpenItem.question("x").key, FleetOpenItem.thread("x").key)
  }

  func testOpenAndCloseSetTheVoiceFocus() {
    let consumer = FleetConsumer(fetchDetail: { request in (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!) })
    consumer.openThread("codex:a")
    XCTAssertEqual(consumer.openItem, .thread("codex:a"))
    XCTAssertEqual(consumer.openThreadKey, "codex:a")
    OverlayState.shared.selectVoiceContext(VoiceFocus(threadKey: "codex:a"))
    consumer.closeItem()
    XCTAssertNil(consumer.openItem)
    XCTAssertNil(OverlayState.shared.voiceFocus.threadKey, "closing clears its own focus")

    OverlayState.shared.selectVoiceContext(VoiceFocus(threadKey: "codex:other"))
    consumer.openThread("codex:a")
    consumer.closeItem()
    XCTAssertEqual(OverlayState.shared.voiceFocus.threadKey, "codex:other", "another item's focus stays")
    OverlayState.shared.selectVoiceContext(VoiceFocus())
  }

  // MARK: - Sending

  func testReplyNoteMapping() {
    let sent = FleetConsumer.replyNote(code: 200, data: Data(#"{"delivery":{"status":"sent"}}"#.utf8), target: .thread(key: "k"))
    XCTAssertTrue(sent.taken)
    XCTAssertFalse(sent.note.isError)
    let queued = FleetConsumer.replyNote(code: 200, data: Data(#"{"delivery":{"status":"queued"}}"#.utf8), target: .thread(key: "k"))
    XCTAssertTrue(queued.taken)
    let blocked = FleetConsumer.replyNote(code: 200, data: Data(#"{"delivery":{"status":"blocked","detail":"approve it in the chat"}}"#.utf8),
                                          target: .question(id: "q"))
    XCTAssertFalse(blocked.taken)
    XCTAssertEqual(blocked.note, FleetNote(text: "Not sent: approve it in the chat", isError: true))
    let oldHub = FleetConsumer.replyNote(code: 400, data: Data(#"{"error":"Pick one of the question's options."}"#.utf8), target: .question(id: "q"))
    XCTAssertFalse(oldHub.taken)
    XCTAssertEqual(oldHub.note, FleetNote(text: "Pick one of the question's options.", isError: true))
  }

  func testThreadReplyPostsToSendAndClearsTheDraftOnlyWhenTaken() async {
    var requests: [URLRequest] = []
    var status = "blocked"
    let state = #"{"enabled":true,"questions":[],"snapshot":{"threads":[{"key":"codex:a","watch":{"group":"working"}}]}}"#
    let consumer = FleetConsumer(
      fetchDetail: { request in (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!) },
      send: { request in
        requests.append(request)
        return self.response(request, 200, #"{"delivery":{"status":"\#(status)","detail":"no route"},"state":\#(state)}"#)
      })
    let item = FleetOpenItem.thread("codex:a")
    consumer.openThread("codex:a")
    consumer.setDraft("  please rebase  ", for: item)
    await consumer.sendReply(item)
    XCTAssertEqual(requests.last?.url?.path, "/fleet/api/send")
    XCTAssertEqual(jsonBody(requests[0])["threadKey"] as? String, "codex:a")
    XCTAssertEqual(jsonBody(requests[0])["message"] as? String, "please rebase")
    XCTAssertEqual(consumer.drafts[item.key], "  please rebase  ", "a blocked send keeps the draft")
    XCTAssertEqual(consumer.replyNotes[item.key]?.isError, true)
    XCTAssertEqual(consumer.openItem, item)

    status = "sent"
    await consumer.sendReply(item)
    XCTAssertNil(consumer.drafts[item.key])
    XCTAssertEqual(consumer.replyNotes[item.key], FleetNote(text: "Sent to the agent.", isError: false))
    XCTAssertFalse(consumer.replyInFlight.contains(item.key))
    consumer.closeItem()
  }

  func testQuestionReplyUsesTheQuestionRouteAndFallsBackToItsThread() async {
    var requests: [URLRequest] = []
    let open = #"{"enabled":true,"questions":[{"id":"q1","kind":"agent-ask","threadKey":"codex:a","canReply":true}],"snapshot":{"threads":[{"key":"codex:a","watch":{"group":"you"}}]}}"#
    let closed = #"{"enabled":true,"questions":[],"snapshot":{"threads":[{"key":"codex:a","watch":{"group":"working"}}]}}"#
    var replies = 0
    let consumer = FleetConsumer(
      fetchDetail: { request in (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!) },
      send: { request in
        requests.append(request)
        if request.url?.path == "/fleet/api/send" {
          return self.response(request, 200, #"{"delivery":{"status":"blocked"},"state":\#(open)}"#)
        }
        replies += 1
        // First an older hub's refusal, then the new hub closing the question.
        if replies == 1 { return self.response(request, 400, #"{"error":"Pick one of the question's options."}"#) }
        return self.response(request, 200, #"{"question":{"id":"q1","status":"answered"},"delivery":{"status":"sent"},"state":\#(closed)}"#)
      })
    // Load a state with the question through a thread send.
    let thread = FleetOpenItem.thread("codex:a")
    consumer.openThread("codex:a")
    consumer.setDraft("hi", for: thread)
    await consumer.sendReply(thread)
    guard let question = consumer.question("q1") else { return XCTFail("the state's question") }
    consumer.openQuestion(question)
    let item = FleetOpenItem.question("q1")
    XCTAssertEqual(consumer.replyTarget(item), .question(id: "q1"))

    consumer.setDraft("Use the staging DB", for: item)
    await consumer.sendReply(item)
    XCTAssertEqual(requests.last?.url?.path, "/fleet/api/questions/q1")
    XCTAssertEqual(jsonBody(requests.last!)["reply"] as? String, "Use the staging DB")
    XCTAssertEqual(consumer.drafts[item.key], "Use the staging DB", "an older hub's 400 keeps the draft")
    XCTAssertEqual(consumer.replyNotes[item.key], FleetNote(text: "Pick one of the question's options.", isError: true))
    XCTAssertEqual(consumer.openItem, item)

    await consumer.sendReply(item)
    XCTAssertEqual(consumer.openItem, thread, "the closed question's screen falls back to its thread")
    XCTAssertNil(consumer.drafts[item.key])
    XCTAssertEqual(consumer.replyNotes[thread.key], FleetNote(text: "Sent to the agent.", isError: false))
    consumer.closeItem()
    OverlayState.shared.selectVoiceContext(VoiceFocus())
  }
}
