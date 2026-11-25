import SupervisorChannelsKit
import XCTest
@testable import OpenAGI

/// A stand-in hub with one shared queue, for the Mac's hub mode: the tray
/// mirrors every device's waiting messages, a busy send queues on the hub,
/// and Edit/Remove/Send Now are hub requests whose refusals are shown.
final class MacFakeHubProtocol: URLProtocol {
  struct Item { var requestId: String; var text: String; var source: String; var mine: Bool; var state: String; var heldBy: String?; var revision: Int }
  static let lock = NSLock()
  static var items: [Item] = []
  static var log: [String] = []
  static var failNextEnqueue = false
  static var fullNextEnqueue = false
  /// Accept the next queued message, then drop the connection (no answer).
  static var dropNextEnqueueAnswer = false
  /// Accept the next queued message but hold its answer until released.
  static var holdNextEnqueue = false
  static var revision = 1
  private static var heldEnqueue: (proto: MacFakeHubProtocol, runLoop: CFRunLoop, answer: [String: Any])?

  static func reset() {
    lock.withLock { items = []; log = []; failNextEnqueue = false; fullNextEnqueue = false; dropNextEnqueueAnswer = false; holdNextEnqueue = false; heldEnqueue = nil; revision = 1 }
  }
  static var isHoldingEnqueue: Bool { lock.withLock { heldEnqueue != nil } }
  static func releaseEnqueue() {
    guard let held = lock.withLock({ () -> (proto: MacFakeHubProtocol, runLoop: CFRunLoop, answer: [String: Any])? in defer { heldEnqueue = nil }; return heldEnqueue }) else { return }
    CFRunLoopPerformBlock(held.runLoop, CFRunLoopMode.commonModes.rawValue) { held.proto.respond(202, held.answer) }
    CFRunLoopWakeUp(held.runLoop)
  }
  static func snapshot() -> [Item] { lock.withLock { items } }
  static func calls() -> [String] { lock.withLock { log } }
  static func set(_ change: (inout [Item]) -> Void) { lock.withLock { change(&items) } }

  private static func queueJSON() -> [String: Any] {
    ["revision": revision, "items": items.enumerated().map { index, item -> [String: Any] in
      var json: [String: Any] = ["requestId": item.requestId, "text": item.text, "source": ["device": item.mine ? "owner" : "phone", "name": item.source],
                                 "mine": item.mine, "state": item.state, "position": index, "revision": item.revision]
      if let heldBy = item.heldBy { json["heldBy"] = heldBy; json["heldByMe"] = heldBy == "Mac" }
      return json
    }]
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  private func respond(_ status: Int, _ object: Any, type: String = "application/json") {
    let data = (object as? String).map { Data($0.utf8) } ?? (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  private func body() -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var bytes = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(bytes, count: n) }
    }
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }

  override func startLoading() {
    XCTAssertEqual(request.url?.host, "daemon.test")
    let path = request.url!.path, method = request.httpMethod ?? "GET"
    let body = body()
    Self.lock.lock()
    defer { Self.lock.unlock() }
    Self.log.append("\(method) \(path)" + (body["text"].map { " \($0)" } ?? "") + ((body["next"] as? Bool) == true ? " NEXT" : ""))
    if path == "/conversations/supervisor/messages" { return respond(200, ["messages": [], "queue": Self.queueJSON()]) }
    if path == "/conversations/supervisor/queue", method == "POST" {
      if Self.failNextEnqueue {
        Self.failNextEnqueue = false
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        return
      }
      if Self.fullNextEnqueue {
        Self.fullNextEnqueue = false
        return respond(429, ["error": "queue_full", "message": "The queue is full."])
      }
      let id = body["requestId"] as? String ?? ""
      var sendNow: [String: Any]? = nil
      if !Self.items.contains(where: { $0.requestId == id }) {
        let item = Item(requestId: id, text: body["text"] as? String ?? "", source: "Mac", mine: true, state: "queued", heldBy: nil, revision: 1)
        if (body["next"] as? Bool) == true, let runningIndex = Self.items.firstIndex(where: { $0.state == "running" }) {
          Self.items.remove(at: runningIndex)
          Self.items.insert(item, at: 0)
          sendNow = ["status": "interrupted"]
        } else {
          Self.items.append(item)
        }
      }
      if Self.dropNextEnqueueAnswer {
        Self.dropNextEnqueueAnswer = false
        client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        return
      }
      var answer: [String: Any] = ["requestId": id, "queue": Self.queueJSON()]
      if let sendNow { answer["sendNow"] = sendNow }
      if Self.holdNextEnqueue {
        Self.holdNextEnqueue = false
        Self.heldEnqueue = (self, CFRunLoopGetCurrent(), answer)
        return
      }
      return respond(202, answer)
    }
    let parts = path.split(separator: "/").map(String.init)
    if parts.count >= 4, parts[2] == "queue", let index = Self.items.firstIndex(where: { $0.requestId == parts[3] }) {
      var item = Self.items[index]
      if parts.count == 5, method == "POST" {
        Self.items.remove(at: index)
        Self.items.insert(item, at: 1)
        return respond(200, ["status": "stopping", "tool": "fleet_status", "queue": Self.queueJSON()])
      }
      if let heldBy = item.heldBy, heldBy != "Mac" { return respond(409, ["error": "held", "message": "\(heldBy) is editing that message."]) }
      if method == "DELETE" {
        Self.items.remove(at: index)
        return respond(200, ["queue": Self.queueJSON()])
      }
      if method == "PATCH" {
        if let text = body["text"] as? String {
          guard (body["baseRevision"] as? Int) == item.revision else { return respond(409, ["error": "conflict"]) }
          item.text = text
          item.revision += 1
          item.heldBy = nil
        }
        if let hold = body["hold"] as? Bool { item.heldBy = hold ? "Mac" : nil }
        Self.items[index] = item
        return respond(200, ["queue": Self.queueJSON()])
      }
    }
    if path == "/message" { return respond(200, "event: final\ndata: {\"reply\":\"ok\"}\n\n", type: "text/event-stream") }
    if path == "/tasks" { return respond(200, ["tasks": []]) }
    respond(200, ["messages": []])
  }
}

@MainActor
final class MacHubQueueTests: XCTestCase {
  override func setUp() { MacFakeHubProtocol.reset() }
  override func tearDown() { MacFakeHubProtocol.reset() }

  private func client(preference: BusySendBehavior = .queue) async -> SharedSupervisorClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MacFakeHubProtocol.self]
    let defaults = UserDefaults(suiteName: "mac-busy-\(UUID().uuidString)")!
    preference.store(in: defaults)
    let supervisor = SharedSupervisorClient(testSession: URLSession(configuration: config), baseURL: URL(string: "http://daemon.test:43210")!,
                                            token: "synthetic", preferences: defaults)
    await supervisor.refreshMessages()
    return supervisor
  }

  private func waitFor(_ what: String, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !condition() {
      if Date() > deadline { XCTFail("Timed out waiting for \(what)"); return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  func testWhileThePhonesTurnRunsTheMacQueuesOnTheHubAndShowsThePhonesMessages() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-1", text: "iPhone's running turn", source: "iPhone", mine: false, state: "running", revision: 1),
                                   .init(requestId: "ios-queued-01", text: "iPhone queued this", source: "iPhone", mine: false, state: "queued", revision: 1)] }
    let supervisor = await client()
    XCTAssertTrue(supervisor.hubQueueAvailable)
    XCTAssertEqual(supervisor.hubRunning?.requestId, "ios-running-1")
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), ["iPhone queued this"])
    XCTAssertEqual(supervisor.queuedMessages.first?.origin?.sourceName, "iPhone")
    let queued = await supervisor.sendMessage("[mac] tagged")
    XCTAssertTrue(queued)
    try await waitFor("the hub to accept it") { MacFakeHubProtocol.snapshot().count == 3 }
    try await waitFor("the mirror") { supervisor.queuedMessages.last?.origin?.pendingUpload == false }
    XCTAssertEqual(supervisor.queuedMessages.map(\.text), ["iPhone queued this", "[mac] tagged"])
    XCTAssertFalse(MacFakeHubProtocol.calls().contains { $0.hasPrefix("POST /message") }, "queued on the hub, not sent around the running turn")
  }

  func testEditRemoveAndSendNowAreHubRequestsAndRefusalsAreShown() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-2", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1),
                                   .init(requestId: "ios-held-0001", text: "phone is editing", source: "iPhone", mine: false, state: "held", heldBy: "iPhone", revision: 1),
                                   .init(requestId: "ios-plain-001", text: "plain", source: "iPhone", mine: false, state: "queued", revision: 1),
                                   .init(requestId: "ios-gone-0001", text: "remove me", source: "iPhone", mine: false, state: "queued", revision: 1)] }
    let supervisor = await client()
    let held = supervisor.queuedMessages[0]
    XCTAssertEqual(held.origin?.heldBy, "iPhone")
    XCTAssertFalse(supervisor.beginEditingQueued(id: held.id), "the phone is editing it")
    XCTAssertFalse(supervisor.canSendQueuedNow(id: held.id))

    supervisor.removeQueued(id: supervisor.queuedMessages[2].id)
    try await waitFor("the removal") { !MacFakeHubProtocol.snapshot().contains { $0.requestId == "ios-gone-0001" } }

    let plain = supervisor.queuedMessages[1]
    XCTAssertTrue(supervisor.beginEditingQueued(id: plain.id))
    try await waitFor("the hold") { MacFakeHubProtocol.snapshot().first { $0.requestId == "ios-plain-001" }?.heldBy == "Mac" }
    supervisor.queuedEditDraft = "plain, edited on the Mac"
    XCTAssertTrue(supervisor.saveQueuedEdit())
    try await waitFor("the save") { MacFakeHubProtocol.snapshot().first { $0.requestId == "ios-plain-001" }?.text == "plain, edited on the Mac" }

    await supervisor.sendQueuedNow(id: supervisor.queuedMessages.first { $0.requestID == "ios-plain-001" }!.id)
    XCTAssertTrue(MacFakeHubProtocol.calls().contains("POST /conversations/supervisor/queue/ios-plain-001/send-now"))
    XCTAssertEqual(supervisor.queuedMessages.first?.requestID, "ios-plain-001")
    XCTAssertEqual(supervisor.queuedMessages.first?.sendNow, .answered(.stopping(tool: "fleet_status")))
  }

  func testAnUploadThatFailedOfflineIsRetriedWithoutAnotherSendOrRefresh() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-3", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1)] }
    let supervisor = await client()
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.failNextEnqueue = true }
    _ = await supervisor.sendMessage("sent during an outage")
    try await waitFor("the failed try") { MacFakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") }.count == 1 }
    XCTAssertEqual(supervisor.queuedMessages.first?.origin?.pendingUpload, true)
    // No send, no refresh: the backoff retry delivers it.
    let deadline = Date().addingTimeInterval(6)
    while !MacFakeHubProtocol.snapshot().contains(where: { $0.text == "sent during an outage" }), Date() < deadline {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTAssertTrue(MacFakeHubProtocol.snapshot().contains { $0.text == "sent during an outage" })
    try await waitFor("the mirror") { supervisor.queuedMessages.first?.origin?.pendingUpload == false }
  }

  func testRemovingAMessageWhoseUploadGotNoAnswerRemovesItOnTheHubToo() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-8", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1)] }
    let supervisor = await client()
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.dropNextEnqueueAnswer = true }
    _ = await supervisor.sendMessage("taken, answer lost")
    try await waitFor("the hub to take it") { MacFakeHubProtocol.snapshot().contains { $0.text == "taken, answer lost" } }
    try await waitFor("the lost answer") { supervisor.queuedMessages.first?.origin?.uploadAttempted == true }
    try await Task.sleep(nanoseconds: 50_000_000)
    let item = try XCTUnwrap(supervisor.queuedMessages.first)
    XCTAssertEqual(item.origin?.pendingUpload, true, "not confirmed here")
    supervisor.removeQueued(id: item.id)
    XCTAssertTrue(supervisor.queuedMessages.isEmpty)
    try await waitFor("the hub removal") { !MacFakeHubProtocol.snapshot().contains { $0.requestId == item.requestID } }
    XCTAssertTrue(MacFakeHubProtocol.calls().contains { $0.hasPrefix("DELETE /conversations/supervisor/queue/\(item.requestID)") })
    await supervisor.refreshMessages()
    XCTAssertTrue(supervisor.queuedMessages.isEmpty, "never comes back, and never runs on the hub")
  }

  func testAMessageWhoseUploadGotNoAnswerOpensForEditOnlyOnceTheHubHasConfirmedIt() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-10", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1)] }
    let supervisor = await client()
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.dropNextEnqueueAnswer = true }
    _ = await supervisor.sendMessage("taken, answer lost, then edited")
    try await waitFor("the hub to take it") { MacFakeHubProtocol.snapshot().contains { $0.text == "taken, answer lost, then edited" } }
    try await waitFor("the lost answer") { supervisor.queuedMessages.first?.origin?.uploadAttempted == true }
    try await Task.sleep(nanoseconds: 50_000_000)
    let item = try XCTUnwrap(supervisor.queuedMessages.first)
    XCTAssertFalse(supervisor.beginEditingQueued(id: item.id), "the hub may already have it without a hold: no local-only edit")
    // That Edit tap asked again (no backoff wait); the hub confirms it has it.
    try await waitFor("the confirmation") { supervisor.queuedMessages.first?.origin?.pendingUpload == false }
    XCTAssertTrue(supervisor.beginEditingQueued(id: item.id))
    try await waitFor("the hub hold") { MacFakeHubProtocol.snapshot().first { $0.requestId == item.requestID }?.heldBy == "Mac" }
    XCTAssertEqual(MacFakeHubProtocol.snapshot().filter { $0.requestId == item.requestID }.count, 1)
  }

  func testAnUploadAnswerOlderThanTheSnapshotShownLeavesNoStaleRow() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-9", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1)] }
    let supervisor = await client()
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.revision = 2; MacFakeHubProtocol.holdNextEnqueue = true }
    _ = await supervisor.sendMessage("finished before its answer came")
    try await waitFor("the hub to take it, answer pending") { MacFakeHubProtocol.isHoldingEnqueue }
    // Meanwhile both turns finished; a newer snapshot (an SSE refresh) comes first.
    MacFakeHubProtocol.set { $0 = [] }
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.revision = 4 }
    await supervisor.refreshMessages()
    XCTAssertEqual(supervisor.queuedMessages.count, 1, "still only here until the answer")
    MacFakeHubProtocol.releaseEnqueue()
    try await waitFor("the late answer") { supervisor.queuedMessages.isEmpty }
    XCTAssertFalse(supervisor.isBusy, "no finished message keeps the Mac busy or offers queue controls")
  }

  func testSendAnywayAndThePreferenceWithAQueueInsteadOverride() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-4", text: "iPhone's reply", source: "iPhone", mine: false, state: "running", revision: 1),
                                   .init(requestId: "ios-queued-04", text: "iPhone queued earlier", source: "iPhone", mine: false, state: "queued", revision: 1)] }
    let supervisor = await client(preference: .queue)
    _ = await supervisor.sendMessage("queued by default")
    _ = await supervisor.sendMessage("send anyway", override: .sendNow)
    try await waitFor("Send anyway's answer") { supervisor.queuedMessages.first?.sendNow == .answered(.interrupted) }
    XCTAssertTrue(MacFakeHubProtocol.calls().contains("POST /conversations/supervisor/queue send anyway NEXT"))
    XCTAssertTrue(MacFakeHubProtocol.calls().contains("POST /conversations/supervisor/queue queued by default"))
    XCTAssertEqual(MacFakeHubProtocol.snapshot().map(\.text), ["send anyway", "iPhone queued earlier", "queued by default"])

    MacFakeHubProtocol.reset()
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-5", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1)] }
    let immediate = await client(preference: .sendNow)
    _ = await immediate.sendMessage("queue instead", override: .queue)
    try await waitFor("the queued one") { MacFakeHubProtocol.calls().contains { $0.hasPrefix("POST /conversations/supervisor/queue") } }
    _ = await immediate.sendMessage("immediately")
    try await waitFor("both delivered") { MacFakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") }.count == 2 }
    XCTAssertEqual(MacFakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") },
                   ["POST /conversations/supervisor/queue queue instead", "POST /conversations/supervisor/queue immediately NEXT"])
  }

  func testAFullQueueIsRetriedOnTheBackoffAndKeepsItsPlace() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-6", text: "busy", source: "iPhone", mine: false, state: "running", revision: 1)] }
    let supervisor = await client()
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.fullNextEnqueue = true }
    _ = await supervisor.sendMessage("while full")
    try await waitFor("the refusal") { MacFakeHubProtocol.calls().filter { $0.contains("while full") }.count == 1 }
    XCTAssertNil(supervisor.queuedMessages.first?.origin?.error)
    let deadline = Date().addingTimeInterval(6)
    while !MacFakeHubProtocol.snapshot().contains(where: { $0.text == "while full" }), Date() < deadline {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTAssertTrue(MacFakeHubProtocol.snapshot().contains { $0.text == "while full" })
  }
}
