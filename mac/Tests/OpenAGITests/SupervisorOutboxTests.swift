import XCTest
@testable import OpenAGI

/// A fake main for the outbox: scripted send results and turn states, and a
/// log of every send so a test can count turns per message.
@MainActor
private final class FakeMain: SupervisorTurnTransport {
  enum SendStep {
    case reply
    case fail(String)
    case notSent
    /// Main took it, then the stream dropped.
    case dropAfterAccept
    /// The request went out and nothing came back (lost acknowledgement).
    case dropBeforeAck
  }

  var sendSteps: [SendStep] = []
  var turnAnswers: [[SupervisorTurnState]] = []
  var supportsTurns = true
  var unreachable = false
  private(set) var sent: [(id: String, text: String, attachments: Int)] = []
  private(set) var turnQueries: [[String]] = []
  private(set) var inFlight = 0
  private(set) var maxInFlight = 0

  func send(_ item: SupervisorOutboxItem, onAccepted: @escaping @MainActor () -> Void) async throws -> SupervisorSendOutcome {
    inFlight += 1
    maxInFlight = max(maxInFlight, inFlight)
    defer { inFlight -= 1 }
    await Task.yield()
    let step: SendStep = sendSteps.isEmpty ? .reply : sendSteps.removeFirst()
    if case .notSent = step { throw SupervisorTransportError.notSent("offline") }
    sent.append((item.id, item.text, item.attachments.count))
    switch step {
    case .reply:
      onAccepted()
      return .replied
    case .fail(let message):
      return .failed(message)
    case .dropAfterAccept:
      onAccepted()
      throw SupervisorTransportError.lost("dropped")
    case .dropBeforeAck:
      throw SupervisorTransportError.lost("no answer")
    case .notSent:
      throw SupervisorTransportError.notSent("offline")
    }
  }

  func turnStates(ids: [String]) async throws -> [String: SupervisorTurnStatus]? {
    turnQueries.append(ids)
    if unreachable { throw URLError(.notConnectedToInternet) }
    guard supportsTurns else { return nil }
    let states = turnAnswers.isEmpty ? Array(repeating: SupervisorTurnState.unknown, count: ids.count) : turnAnswers.removeFirst()
    return Dictionary(uniqueKeysWithValues: zip(ids, states).map { ($0, SupervisorTurnStatus(requestId: $0, state: $1)) })
  }
}

@MainActor
final class SupervisorOutboxTests: XCTestCase {
  private var fileURL: URL!

  override func setUp() async throws {
    fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("supervisor-outbox-tests-\(UUID().uuidString)")
      .appendingPathComponent("outbox.json")
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
  }

  private func makeOutbox(_ main: FakeMain) -> SupervisorOutbox {
    let outbox = SupervisorOutbox(store: SupervisorOutboxStore(url: fileURL), pollDelays: [.milliseconds(1)], retryDelays: [])
    outbox.transport = main
    return outbox
  }

  private func saved() -> [SupervisorOutboxItem] { SupervisorOutboxStore(url: fileURL).load() }

  func testQueuedSendsGoOneAtATimeInOrderOncePerMessage() async {
    let main = FakeMain()
    let outbox = makeOutbox(main)
    let ids = ["one", "two", "three"].map { outbox.enqueue(text: $0).id }
    XCTAssertEqual(saved().map(\.id), ids, "saved before anything was sent")
    XCTAssertTrue(main.sent.isEmpty)

    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.id), ids)
    XCTAssertEqual(main.maxInFlight, 1, "never two sends on the wire")
    XCTAssertTrue(outbox.items.isEmpty)
    XCTAssertTrue(saved().isEmpty)
  }

  func testOfflineSendsWaitAndSurviveARestartThenGoWithTheSameIds() async {
    let main = FakeMain()
    main.sendSteps = [.notSent]
    let outbox = makeOutbox(main)
    let ids = ["first", "second", "third"].map { outbox.enqueue(text: $0).id }
    await outbox.drain()
    XCTAssertTrue(main.sent.isEmpty, "offline: nothing went, and nothing burst out after it")
    XCTAssertEqual(outbox.items.map(\.state), [.queued, .queued, .queued])
    XCTAssertNotNil(outbox.holdReason)

    // The Mac quits and relaunches with the network back.
    let relaunched = makeOutbox(main)
    XCTAssertEqual(relaunched.items.map(\.id), ids)
    await relaunched.drain()
    XCTAssertEqual(main.sent.map(\.id), ids)
    XCTAssertEqual(main.maxInFlight, 1)
    XCTAssertTrue(relaunched.items.isEmpty)
  }

  func testASendCutOffByAQuitIsCheckedWithMainBeforeItGoesAgain() async {
    // Quit mid-send: the file says sending. Main restarted and never took it.
    let main = FakeMain()
    main.sendSteps = [.dropBeforeAck]
    let first = makeOutbox(main)
    let id = first.enqueue(text: "after the restart").id
    await first.drain()
    XCTAssertEqual(saved().map(\.state), [.sending])

    main.turnAnswers = [[.unknown]]
    let relaunched = makeOutbox(main)
    await relaunched.drain()
    XCTAssertEqual(main.turnQueries, [[id]], "asked main first")
    XCTAssertEqual(main.sent.map(\.id), [id, id], "sent again under the same id, so main runs it once")
    XCTAssertTrue(relaunched.items.isEmpty)
  }

  func testReconnectingDuringAnActiveTurnWaitsForItBeforeSendingTheNext() async {
    let main = FakeMain()
    main.sendSteps = [.dropAfterAccept]
    let outbox = makeOutbox(main)
    let first = outbox.enqueue(text: "long job").id
    let second = outbox.enqueue(text: "after it").id
    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.id), [first], "the drop stops the drain: no burst")
    XCTAssertEqual(outbox.items.map(\.state), [.accepted, .queued])

    main.turnAnswers = [[.running], [.running], [.done]]
    await outbox.drain()
    XCTAssertEqual(main.turnQueries, [[first], [first], [first]])
    XCTAssertEqual(main.sent.map(\.id), [first, second], "the accepted send is never sent again")
    XCTAssertTrue(outbox.items.isEmpty)
  }

  func testALostAcknowledgementAfterMainTookTheSendIsNeverResent() async {
    let main = FakeMain()
    main.sendSteps = [.dropBeforeAck]
    let outbox = makeOutbox(main)
    let id = outbox.enqueue(text: "book the room").id
    await outbox.drain()
    XCTAssertEqual(outbox.items.first?.state, .sending)

    main.turnAnswers = [[.queued], [.done]]
    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.id), [id], "one send, one turn")
    XCTAssertTrue(outbox.items.isEmpty)
  }

  func testIdenticalTextSentTwiceIsTwoMessages() async {
    let main = FakeMain()
    let outbox = makeOutbox(main)
    let a = outbox.enqueue(text: "yes")
    let b = outbox.enqueue(text: "yes")
    XCTAssertNotEqual(a.id, b.id)
    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.text), ["yes", "yes"])
    XCTAssertEqual(Set(main.sent.map(\.id)).count, 2)
  }

  func testAnOlderMainThatCannotConfirmASendNeverGetsItAgain() async {
    let main = FakeMain()
    main.sendSteps = [.dropBeforeAck]
    main.supportsTurns = false
    let outbox = makeOutbox(main)
    let ambiguous = outbox.enqueue(text: "did it go?").id
    let next = outbox.enqueue(text: "next").id
    await outbox.drain()
    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.id), [ambiguous, next], "the ambiguous one went once; the next was never sent")
    XCTAssertEqual(outbox.items.map(\.state), [.failed])
    XCTAssertTrue(outbox.items[0].failure?.contains("Check the conversation") == true)
  }

  func testUnreachableMainHoldsEverythingWithoutSending() async {
    let main = FakeMain()
    main.sendSteps = [.dropAfterAccept]
    let outbox = makeOutbox(main)
    outbox.enqueue(text: "one")
    outbox.enqueue(text: "two")
    await outbox.drain()
    main.unreachable = true
    await outbox.drain()
    await outbox.drain()
    XCTAssertEqual(main.sent.count, 1)
    XCTAssertEqual(outbox.items.map(\.state), [.accepted, .queued])
  }

  func testFailuresNeedTheOwnerAndRetryIsANewMessage() async {
    let main = FakeMain()
    main.sendSteps = [.fail("rate limited"), .dropAfterAccept]
    let outbox = makeOutbox(main)
    let failing = outbox.enqueue(text: "first").id
    let interrupted = outbox.enqueue(text: "second").id
    await outbox.drain()
    main.turnAnswers = [[.interrupted]]
    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.id), [failing, interrupted])
    XCTAssertEqual(outbox.items.map(\.state), [.failed, .failed])
    XCTAssertEqual(outbox.items[0].failure, "rate limited")

    outbox.retry(id: failing)
    let retried = outbox.items[0]
    XCTAssertNotEqual(retried.id, failing, "a retry is a new turn")
    XCTAssertEqual(retried.state, .queued)
    await outbox.drain()
    XCTAssertEqual(main.sent.map(\.id), [failing, interrupted, retried.id])
    XCTAssertEqual(outbox.items.map(\.id), [interrupted])
    XCTAssertNotNil(outbox.remove(id: interrupted))
    XCTAssertTrue(saved().isEmpty)
  }

  func testAttachmentsAreSavedAndSentWithTheirSend() async {
    let main = FakeMain()
    let outbox = makeOutbox(main)
    let image = SupervisorOutboxAttachment(id: "img_1", name: "shot.jpg", mimeType: "image/jpeg", data: "AAAA", thumbnail: "AA==")
    outbox.enqueue(text: "", attachments: [image])
    XCTAssertEqual(saved().first?.attachments, [image])
    await outbox.drain()
    XCTAssertEqual(main.sent.first?.attachments, 1)
  }

  func testOnlyNeverSentOrFailedSendsCanBeTakenBack() async {
    let main = FakeMain()
    main.sendSteps = [.dropAfterAccept]
    let outbox = makeOutbox(main)
    let accepted = outbox.enqueue(text: "accepted").id
    let queued = outbox.enqueue(text: "queued").id
    await outbox.drain()
    XCTAssertNil(outbox.remove(id: accepted))
    XCTAssertNotNil(outbox.remove(id: queued))
  }

  func testThePayloadNamesTheTurnOnlyOnTheSharedThread() {
    let named = SharedSupervisorClient.buildMessagePayload(text: "Hi", requestId: "mac-0123456789")
    XCTAssertEqual(named["requestId"] as? String, "mac-0123456789")
    let legacy = SharedSupervisorClient.buildMessagePayload(text: "Hi", includeThread: false, includeFocusedCard: false, requestId: "mac-0123456789")
    XCTAssertNil(legacy["requestId"])
    let saved = SupervisorOutboxAttachment(id: "img_1", name: "a.jpg", mimeType: "image/jpeg", data: "AAAA", thumbnail: "AA==")
    let withImage = SharedSupervisorClient.buildMessagePayload(text: "Look", requestId: "mac-0123456789", savedAttachments: [saved])
    XCTAssertEqual((withImage["attachments"] as? [[String: Any]])?.first?["id"] as? String, "img_1")
  }

  func testTurnStatesDecodeAndAnUnknownStateMeansWait() throws {
    let data = Data(#"{"turns":[{"requestId":"mac-a","state":"done"},{"requestId":"mac-b","state":"paused-somehow"}]}"#.utf8)
    struct Response: Decodable { let turns: [SupervisorTurnStatus] }
    let decoded = try JSONDecoder().decode(Response.self, from: data)
    XCTAssertEqual(decoded.turns.map(\.state), [.done, .running])
  }

  func testOnlyConnectFailuresCountAsNotSent() {
    XCTAssertEqual(SharedSupervisorClient.transportError(URLError(.notConnectedToInternet)), .notSent(URLError(.notConnectedToInternet).localizedDescription))
    if case .notSent = SharedSupervisorClient.transportError(URLError(.timedOut)) { XCTFail("a timeout may have reached main") }
    if case .notSent = SharedSupervisorClient.transportError(URLError(.networkConnectionLost)) { XCTFail("a dropped connection may have reached main") }
  }
}
