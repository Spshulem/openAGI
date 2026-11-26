import AppKit
import SupervisorChannelsKit
import SwiftUI
import XCTest
@testable import OpenAGI

/// A stand-in daemon whose `/message` streams stay open until the test lets
/// them finish. Only this test's own URLSession uses it: nothing here can
/// reach a real daemon.
final class MacHeldStreamProtocol: URLProtocol {
  struct Sent: Equatable { let text: String; let requestId: String?; let thread: String? }
  private struct Held { let proto: MacHeldStreamProtocol; let runLoop: CFRunLoop }
  static let lock = NSLock()
  /// What GET .../messages answers (main's shared history).
  static var history = "{\"messages\":[]}"
  private static var held: [String: Held] = [:]
  static var hold: Set<String> = []
  private static var sent: [Sent] = []
  private static var interrupts: [String] = []
  static var answerInterrupt: ((String) -> (Int, String))?
  /// Answer like a main older than turn ids: a requestId is an unsupported field.
  static var rejectRequestId = false

  static func reset() { lock.withLock { held = [:]; hold = []; sent = []; interrupts = []; answerInterrupt = nil; rejectRequestId = false; history = "{\"messages\":[]}" } }
  static var sentTexts: [String] { lock.withLock { sent.map(\.text) } }
  static var sentTurns: [Sent] { lock.withLock { sent } }
  static var interruptIDs: [String] { lock.withLock { interrupts } }
  static func isHeld(_ text: String) -> Bool { lock.withLock { held[text] != nil } }

  static func release(_ text: String, frames: String) {
    guard let entry = lock.withLock({ held.removeValue(forKey: text) }) else { return }
    let proto = entry.proto
    CFRunLoopPerformBlock(entry.runLoop, CFRunLoopMode.commonModes.rawValue) {
      proto.client?.urlProtocol(proto, didLoad: Data(frames.utf8))
      proto.client?.urlProtocolDidFinishLoading(proto)
    }
    CFRunLoopWakeUp(entry.runLoop)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  private func respond(_ status: Int, _ body: String, type: String = "application/json") {
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  private func jsonBody() -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var bytes = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&bytes, maxLength: bytes.count)
        if count <= 0 { break }
        data.append(bytes, count: count)
      }
    }
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }

  override func startLoading() {
    XCTAssertEqual(request.url?.host, "daemon.test", "tests never talk to a real daemon")
    let path = request.url!.path
    if path == "/message" {
      let body = jsonBody()
      let text = body["text"] as? String ?? ""
      if body["requestId"] != nil, Self.lock.withLock({ Self.rejectRequestId }) {
        respond(400, "{\"error\":\"node message contains unsupported fields\"}")
        return
      }
      let shouldHold = Self.lock.withLock {
        Self.sent.append(Sent(text: text, requestId: body["requestId"] as? String, thread: body["thread"] as? String))
        return Self.hold.contains(text)
      }
      if shouldHold {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("event: status\ndata: {\"stage\":\"thinking\"}\n\n".utf8))
        Self.lock.withLock { Self.held[text] = Held(proto: self, runLoop: CFRunLoopGetCurrent()) }
      } else {
        respond(200, "event: final\ndata: {\"reply\":\"Ack: \(text)\"}\n\n", type: "text/event-stream")
      }
      return
    }
    if path == "/conversations/supervisor/interrupt" {
      let requestId = jsonBody()["requestId"] as? String ?? ""
      let answer = Self.lock.withLock { () -> ((String) -> (Int, String))? in
        Self.interrupts.append(requestId)
        return Self.answerInterrupt
      }
      let (status, json) = answer?(requestId) ?? (404, "{\"error\":\"not_found\"}")
      respond(status, json)
      return
    }
    if path == "/tasks" { respond(200, "{\"tasks\":[]}"); return }
    respond(200, Self.lock.withLock { Self.history })
  }

  override func stopLoading() {}
}

@MainActor
final class SupervisorQueueControlsTests: XCTestCase {
  private static let stopped = "event: failure\ndata: {\"code\":\"stopped\",\"error\":\"Stopped so your next message could go first.\"}\n\n"

  override func setUp() { MacHeldStreamProtocol.reset() }
  override func tearDown() { MacHeldStreamProtocol.reset() }

  private func client() -> SharedSupervisorClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MacHeldStreamProtocol.self]
    return SharedSupervisorClient(testSession: URLSession(configuration: config),
                                  baseURL: URL(string: "http://daemon.test:43210")!, token: "synthetic-token")
  }

  private func waitFor(_ what: String, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !condition() {
      if Date() > deadline { XCTFail("Timed out waiting for \(what)"); return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  private func busy(_ supervisor: SharedSupervisorClient, running: String, queued: [String]) async throws -> Task<Bool, Never> {
    MacHeldStreamProtocol.hold.insert(running)
    let first = Task { await supervisor.sendMessage(running) }
    try await waitFor("the running reply to reach main") { MacHeldStreamProtocol.isHeld(running) }
    for text in queued {
      let queuedOK = await supervisor.sendMessage(text)
      XCTAssertTrue(queuedOK, "Send while busy queues")
    }
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), queued)
    return first
  }

  func testSendNowInterruptsTheReplyAndSendsTheChosenMessageNextInTheSameThread() async throws {
    let supervisor = client()
    let first = try await busy(supervisor, running: "Plan Tuesday", queued: ["Invite Sam", "Make it Wednesday", "Book a room"])
    let runningTurn = try XCTUnwrap(MacHeldStreamProtocol.sentTurns[0].requestId, "the Mac names its turns")
    MacHeldStreamProtocol.answerInterrupt = { requestId in
      MacHeldStreamProtocol.release("Plan Tuesday", frames: Self.stopped)
      return (200, "{\"status\":\"interrupted\",\"requestId\":\"\(requestId)\"}")
    }
    let chosen = supervisor.queuedMessages[1]
    await supervisor.sendQueuedNow(id: chosen.id)
    _ = await first.value
    try await waitFor("the queue to drain") { !supervisor.isSending }

    XCTAssertEqual(MacHeldStreamProtocol.interruptIDs, [runningTurn])
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Plan Tuesday", "Make it Wednesday", "Invite Sam", "Book a room"])
    XCTAssertEqual(MacHeldStreamProtocol.sentTurns[1].requestId, chosen.requestID)
    XCTAssertTrue(MacHeldStreamProtocol.sentTurns.allSatisfy { $0.thread == "supervisor" }, "same conversation")
    XCTAssertEqual(Set(MacHeldStreamProtocol.sentTurns.compactMap(\.requestId)).count, 4, "nothing sent twice")
    XCTAssertNil(supervisor.lastError, "a stop the owner asked for is not shown as an error")
  }

  func testDoubleTapSendsOneInterruptAndStoppingNamesTheRunningAction() async throws {
    let supervisor = client()
    let first = try await busy(supervisor, running: "Long task", queued: ["Correction"])
    MacHeldStreamProtocol.answerInterrupt = { requestId in
      Thread.sleep(forTimeInterval: 0.1)
      return (200, "{\"status\":\"stopping\",\"tool\":\"send_email\",\"requestId\":\"\(requestId)\"}")
    }
    let id = supervisor.queuedMessages[0].id
    async let a: Void = supervisor.sendQueuedNow(id: id)
    async let b: Void = supervisor.sendQueuedNow(id: id)
    _ = await (a, b)
    XCTAssertEqual(MacHeldStreamProtocol.interruptIDs.count, 1)
    XCTAssertEqual(supervisor.queuedMessages[0].sendNow, .answered(.stopping(tool: "send_email")))
    XCTAssertFalse(supervisor.canSendQueuedNow(id: id))
    MacHeldStreamProtocol.release("Long task", frames: Self.stopped)
    _ = await first.value
    try await waitFor("the queue to drain") { !supervisor.isSending }
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Long task", "Correction"])
  }

  func testAnOlderMainIsReportedHonestlyAndTheReplyFinishesNormally() async throws {
    let supervisor = client()
    let first = try await busy(supervisor, running: "Question", queued: ["A", "B"])
    MacHeldStreamProtocol.answerInterrupt = { _ in (404, "{\"error\":\"not_found\"}") }
    await supervisor.sendQueuedNow(id: supervisor.queuedMessages[1].id)
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), ["B", "A"])
    XCTAssertEqual(supervisor.queuedMessages[0].sendNow, .answered(.unsupported))
    XCTAssertTrue(MacHeldStreamProtocol.isHeld("Question"), "nothing claimed it stopped")
    MacHeldStreamProtocol.release("Question", frames: "event: final\ndata: {\"reply\":\"Full answer\"}\n\n")
    _ = await first.value
    try await waitFor("the queue to drain") { !supervisor.isSending }
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Question", "B", "A"])
  }

  func testEditHoldsTheQueueNeverSendsTheOldTextAndKeepsItsPlace() async throws {
    let supervisor = client()
    let first = try await busy(supervisor, running: "Running", queued: ["Typo here", "After it"])
    let typo = supervisor.queuedMessages[0].id
    XCTAssertTrue(supervisor.beginEditingQueued(id: typo))
    XCTAssertEqual(supervisor.queuedEditDraft, "Typo here")
    MacHeldStreamProtocol.release("Running", frames: "event: final\ndata: {\"reply\":\"ok\"}\n\n")
    _ = await first.value
    try await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Running"], "the queue waits at the open edit")
    XCTAssertFalse(supervisor.isSending)

    let queuedOK = await supervisor.sendMessage("Typed meanwhile")
    XCTAssertTrue(queuedOK)
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), ["Typo here", "After it", "Typed meanwhile"], "new messages go after, not ahead")

    supervisor.queuedEditDraft = "Typo fixed"
    XCTAssertTrue(supervisor.saveQueuedEdit())
    try await waitFor("the queue to drain") { supervisor.queuedMessages.isEmpty && !supervisor.isSending }
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Running", "Typo fixed", "After it", "Typed meanwhile"])
  }

  /// QA only: renders the real tray to PNGs when OPENAGI_QA_SNAPSHOT_DIR is
  /// set (skipped otherwise, so CI never writes files).
  func testRenderQueueTrayForQA() async throws {
    guard let dir = ProcessInfo.processInfo.environment["OPENAGI_QA_SNAPSHOT_DIR"] else {
      throw XCTSkip("QA snapshots only on request")
    }
    let supervisor = client()
    let first = try await busy(supervisor, running: "Check my agents", queued: ["Draft the update for Tuesday", "Also invite Sam", "Book a room"])
    MacHeldStreamProtocol.answerInterrupt = { id in (200, "{\"status\":\"stopping\",\"tool\":\"fleet_status\",\"requestId\":\"\(id)\"}") }
    func render(_ name: String) throws {
      let view = SupervisorQueueTray(supervisor: supervisor)
        .frame(width: 600)
        .padding(16)
        .background(Color(nsColor: .windowBackgroundColor))
      let renderer = ImageRenderer(content: view)
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.nsImage)
      let rep = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
      try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
    try render("mac-queue-tray")
    XCTAssertTrue(supervisor.beginEditingQueued(id: supervisor.queuedMessages[0].id))
    supervisor.queuedEditDraft = "Draft the update for Tuesday, make it Wednesday"
    try render("mac-queue-editing")
    XCTAssertTrue(supervisor.saveQueuedEdit())
    await supervisor.sendQueuedNow(id: supervisor.queuedMessages[1].id)
    try render("mac-queue-send-now-stopping")
    MacHeldStreamProtocol.release("Check my agents", frames: Self.stopped)
    _ = await first.value
  }

  func testInterruptAnswersMapOnlyToWhatMainConfirmed() {
    func outcome(_ status: Int, _ body: String) -> TurnInterruptOutcome {
      SharedSupervisorClient.interruptOutcome(data: Data(body.utf8), status: status)
    }
    XCTAssertEqual(outcome(200, #"{"status":"interrupted"}"#), .interrupted)
    XCTAssertEqual(outcome(200, #"{"status":"stopping","tool":"fleet_send"}"#), .stopping(tool: "fleet_send"))
    XCTAssertEqual(outcome(200, #"{"status":"finished","outcome":"complete"}"#), .finished)
    XCTAssertEqual(outcome(200, #"{"status":"not_found"}"#), .notFound)
    XCTAssertEqual(outcome(404, "{}"), .unsupported)
    XCTAssertEqual(outcome(500, #"{"status":"interrupted"}"#), .unreachable, "an error status is never a success")
    XCTAssertEqual(outcome(200, "<html>"), .unreachable)
  }

  func testAfterTheStreamDropsMainsRunningTurnIsTheOneSendNowStopsAndTheQueueWaitsForIt() async throws {
    let supervisor = client()
    let first = try await busy(supervisor, running: "Long job", queued: ["Queued behind it", "Correction"])
    let longJob = try XCTUnwrap(MacHeldStreamProtocol.sentTurns[0].requestId)
    // The stream goes while main keeps running the turn.
    MacHeldStreamProtocol.lock.withLock {
      MacHeldStreamProtocol.history = "{\"messages\":[],\"inFlight\":[{\"requestId\":\"\(longJob)\",\"stage\":\"model\"}]}"
    }
    MacHeldStreamProtocol.release("Long job", frames: "")
    _ = await first.value
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(supervisor.outstandingRequestIds, [longJob], "remembered until main says how it ended")
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Long job"], "nothing is sent behind a turn main still runs")
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), ["Queued behind it", "Correction"])

    MacHeldStreamProtocol.answerInterrupt = { requestId in
      MacHeldStreamProtocol.history = "{\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"text\":\"Long job\",\"requestId\":\"\(requestId)\"},{\"id\":\"a1\",\"role\":\"assistant\",\"text\":\"Stopped so your next message could go first.\",\"requestId\":\"\(requestId)\"}],\"inFlight\":[]}"
      return (200, "{\"status\":\"interrupted\",\"requestId\":\"\(requestId)\"}")
    }
    await supervisor.sendQueuedNow(id: supervisor.queuedMessages[1].id)
    XCTAssertEqual(MacHeldStreamProtocol.interruptIDs, [longJob], "the turn main is running, not a later one")
    try await waitFor("the queue to drain") { supervisor.queuedMessages.isEmpty && !supervisor.isSending }
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Long job", "Correction", "Queued behind it"])
    XCTAssertTrue(supervisor.outstandingRequestIds.isEmpty)
  }

  func testPartialTextWithoutAFinalFrameIsNotAFinishedReplyAndTheQueueWaits() async throws {
    let supervisor = client()
    let first = try await busy(supervisor, running: "Long job", queued: ["Next"])
    let longJob = try XCTUnwrap(MacHeldStreamProtocol.sentTurns[0].requestId)
    MacHeldStreamProtocol.lock.withLock {
      MacHeldStreamProtocol.history = "{\"messages\":[],\"inFlight\":[{\"requestId\":\"\(longJob)\",\"stage\":\"model\"}]}"
    }
    // Some text, then the connection ends with no final frame.
    MacHeldStreamProtocol.release("Long job", frames: "event: delta\ndata: {\"text\":\"Half an ans\"}\n\n")
    let ok = await first.value
    XCTAssertFalse(ok, "half a reply is not a finished turn")
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(supervisor.outstandingRequestIds, [longJob], "main may still run it: remembered until history says")
    XCTAssertFalse(supervisor.messages.contains { $0.role == "assistant" && $0.text == "Half an ans" }, "never shown as the reply")
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Long job"], "nothing is sent behind it")
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), ["Next"])

    MacHeldStreamProtocol.lock.withLock {
      MacHeldStreamProtocol.history = "{\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"text\":\"Long job\",\"requestId\":\"\(longJob)\"},{\"id\":\"a1\",\"role\":\"assistant\",\"text\":\"Half an answer, finished.\",\"requestId\":\"\(longJob)\"}],\"inFlight\":[]}"
    }
    await supervisor.refreshMessages()
    try await waitFor("the queue to drain") { supervisor.queuedMessages.isEmpty && !supervisor.isSending }
    XCTAssertEqual(MacHeldStreamProtocol.sentTexts, ["Long job", "Next"])
    XCTAssertTrue(supervisor.outstandingRequestIds.isEmpty)
  }
}
