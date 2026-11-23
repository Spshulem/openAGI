import SupervisorChannelsKit
import XCTest
@testable import OpenAGI

/// A stand-in hub with one shared queue, for the Mac's hub mode: the tray
/// mirrors every device's waiting messages, a busy send queues on the hub,
/// and Edit/Remove/Send Now are hub requests whose refusals are shown.
final class MacFakeHubProtocol: URLProtocol {
  struct Item { var requestId: String; var text: String; var source: String; var mine: Bool; var state: String; var heldBy: String?; var revision: Int }
  private static let lock = NSLock()
  static var items: [Item] = []
  static var log: [String] = []

  static func reset() { lock.withLock { items = []; log = [] } }
  static func snapshot() -> [Item] { lock.withLock { items } }
  static func calls() -> [String] { lock.withLock { log } }
  static func set(_ change: (inout [Item]) -> Void) { lock.withLock { change(&items) } }

  private static func queueJSON() -> [String: Any] {
    ["revision": 1, "items": items.enumerated().map { index, item -> [String: Any] in
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
    Self.log.append("\(method) \(path)" + (body["text"].map { " \($0)" } ?? ""))
    if path == "/conversations/supervisor/messages" { return respond(200, ["messages": [], "queue": Self.queueJSON()]) }
    if path == "/conversations/supervisor/queue", method == "POST" {
      let id = body["requestId"] as? String ?? ""
      if !Self.items.contains(where: { $0.requestId == id }) {
        Self.items.append(Item(requestId: id, text: body["text"] as? String ?? "", source: "Mac", mine: true, state: "queued", heldBy: nil, revision: 1))
      }
      return respond(202, ["requestId": id, "queue": Self.queueJSON()])
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

  private func client() async -> SharedSupervisorClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MacFakeHubProtocol.self]
    let supervisor = SharedSupervisorClient(testSession: URLSession(configuration: config), baseURL: URL(string: "http://daemon.test:43210")!, token: "synthetic")
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
}
