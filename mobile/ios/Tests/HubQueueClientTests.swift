import XCTest
import SupervisorChannelsKit
@testable import OpenAGI

// A stand-in hub that keeps one shared queue (src/conversation-queue.js), so
// the phone's hub mode can be checked without a network: it mirrors every
// device's waiting messages, queues on the hub instead of locally, retries
// with the same id, and turns Edit/Remove/Send Now into hub requests with
// the hub's refusals shown.
final class FakeHubProtocol: URLProtocol, @unchecked Sendable {
    struct Item { var requestId: String; var text: String; var source: String; var mine: Bool; var state: String; var heldBy: String?; var revision: Int }
    private static let lock = NSLock()
    nonisolated(unsafe) static var items: [Item] = []
    nonisolated(unsafe) static var log: [String] = []
    nonisolated(unsafe) static var failNextEnqueue = false
    nonisolated(unsafe) static var sendNowStatus = "interrupted"

    static func reset() { lock.withLock { items = []; log = []; failNextEnqueue = false; sendNowStatus = "interrupted" } }
    static func snapshot() -> [Item] { lock.withLock { items } }
    static func calls() -> [String] { lock.withLock { log } }
    static func set(_ change: (inout [Item]) -> Void) { lock.withLock { change(&items) } }

    private static func queueJSON() -> [String: Any] {
        ["revision": 1, "items": items.enumerated().map { index, item -> [String: Any] in
            var json: [String: Any] = ["requestId": item.requestId, "text": item.text, "source": ["device": item.mine ? "phone" : "owner", "name": item.source],
                                       "mine": item.mine, "state": item.state, "position": index, "revision": item.revision]
            if let heldBy = item.heldBy { json["heldBy"] = heldBy; json["heldByMe"] = heldBy == "iPhone" }
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
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        let body = body()
        Self.lock.lock()
        defer { Self.lock.unlock() }
        Self.log.append("\(method) \(path)" + (body["text"].map { " \($0)" } ?? "") + (body["requestId"].map { " #\($0)" } ?? ""))
        if path == "/conversations/supervisor/messages" { return respond(200, ["messages": [], "queue": Self.queueJSON()]) }
        if path == "/conversations/supervisor/queue", method == "POST" {
            if Self.failNextEnqueue {
                Self.failNextEnqueue = false
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            let id = body["requestId"] as? String ?? ""
            if !Self.items.contains(where: { $0.requestId == id }) {
                Self.items.append(Item(requestId: id, text: body["text"] as? String ?? "", source: "iPhone", mine: true, state: "queued", heldBy: nil, revision: 1))
            }
            return respond(202, ["requestId": id, "queue": Self.queueJSON()])
        }
        let parts = path.split(separator: "/").map(String.init)
        if parts.count >= 4, parts[2] == "queue", let index = Self.items.firstIndex(where: { $0.requestId == parts[3] }) {
            var item = Self.items[index]
            if parts.count == 5, method == "POST" {
                Self.items.remove(at: index)
                Self.items.insert(item, at: Self.items.first?.state == "running" ? 1 : 0)
                return respond(200, ["status": Self.sendNowStatus, "queue": Self.queueJSON()])
            }
            if let heldBy = item.heldBy, heldBy != "iPhone" {
                return respond(409, ["error": "held", "message": "\(heldBy) is editing that message."])
            }
            if method == "DELETE" {
                Self.items.remove(at: index)
                return respond(200, ["removed": item.requestId, "queue": Self.queueJSON()])
            }
            if method == "PATCH" {
                if let text = body["text"] as? String {
                    guard (body["baseRevision"] as? Int) == item.revision else {
                        return respond(409, ["error": "conflict", "message": "changed"])
                    }
                    item.text = text
                    item.revision += 1
                }
                if let hold = body["hold"] as? Bool { item.heldBy = hold ? "iPhone" : nil }
                if body["text"] != nil { item.heldBy = nil }
                Self.items[index] = item
                return respond(200, ["queue": Self.queueJSON()])
            }
        }
        if parts.count >= 4, parts[2] == "queue" { return respond(409, ["error": "already_sent"]) }
        if path == "/message" { return respond(200, "event: final\ndata: {\"reply\":\"ok\"}\n\n", type: "text/event-stream") }
        respond(200, ["messages": []])
    }
}

final class HubQueueClientTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "hub-queue-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        FakeHubProtocol.reset()
    }

    override func tearDownWithError() throws {
        FakeHubProtocol.reset()
        try FileManager.default.removeItem(at: directory)
    }

    @MainActor
    private func chat() async -> ChatConversation {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeHubProtocol.self]
        let client = DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:test", token: "synthetic-token",
                                  session: URLSession(configuration: config))
        let conversation = ChatConversation(thread: .supervisor, client: client,
                                            store: ChatHistoryStore(thread: "hub-\(UUID().uuidString)", directory: directory), nodeID: "mobile:test")
        await conversation.refresh()
        return conversation
    }

    @MainActor
    private func waitFor(_ what: String, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            if ContinuousClock.now > deadline { XCTFail("Timed out waiting for \(what)"); return }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    func testWhileAnotherDevicesTurnRunsTheMessageGoesToTheHubsQueueAndShowsWithEveryoneElses() async throws {
        FakeHubProtocol.set { items in
            items = [.init(requestId: "mac-running-1", text: "Mac's running turn", source: "Mac", mine: false, state: "running", revision: 1),
                     .init(requestId: "mac-queued-1", text: "Mac queued this", source: "Mac", mine: false, state: "queued", revision: 1)]
        }
        let chat = await chat()
        XCTAssertTrue(chat.hubQueueAvailable)
        XCTAssertEqual(chat.hubRunning?.requestId, "mac-running-1")
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Mac queued this"], "the other device's waiting message shows here")
        XCTAssertEqual(chat.queuedSubmissions.first?.origin?.sourceName, "Mac")

        chat.draft = "[ios] phone's message"
        XCTAssertTrue(chat.submitDraft())
        try await waitFor("the hub to accept it") { FakeHubProtocol.snapshot().count == 3 }
        try await waitFor("the tray to show the hub's order") { chat.queuedSubmissions.last?.origin?.pendingUpload == false }
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Mac queued this", "[ios] phone's message"])
        XCTAssertFalse(FakeHubProtocol.calls().contains { $0.hasPrefix("POST /message") }, "queued on the hub, not sent around it")
        XCTAssertFalse(chat.isSending)
    }

    @MainActor
    func testAnEnqueueThatNeverGotAnAnswerIsRetriedWithTheSameIdAndKeptOnce() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-2", text: "busy", source: "Mac", mine: false, state: "running", revision: 1)] }
        let chat = await chat()
        FakeHubProtocol.failNextEnqueue = true
        chat.draft = "survives a dropped connection"
        XCTAssertTrue(chat.submitDraft())
        try await waitFor("the first try to fail") { FakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") }.count == 1 }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(chat.queuedSubmissions.first?.origin?.pendingUpload, true, "kept here, marked not on main yet")
        let id = try XCTUnwrap(chat.queuedSubmissions.first?.requestID)

        await chat.refresh()
        try await waitFor("the retry") { FakeHubProtocol.snapshot().contains { $0.requestId == id } }
        let tries = FakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") }
        XCTAssertEqual(tries.count, 2)
        XCTAssertTrue(tries.allSatisfy { $0.hasSuffix("#\(id)") }, "the same turn id both times")
        XCTAssertEqual(FakeHubProtocol.snapshot().filter { $0.requestId == id }.count, 1)
    }

    @MainActor
    func testEditHoldsOnTheHubAndSavesAgainstItsRevision_AStaleSaveIsRefusedAndShown() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-3", text: "busy", source: "Mac", mine: false, state: "running", revision: 1),
                                    .init(requestId: "ios-edit-0001", text: "Tuesday", source: "iPhone", mine: true, state: "queued", revision: 1)] }
        let chat = await chat()
        let id = try XCTUnwrap(chat.queuedSubmissions.first?.id)
        XCTAssertTrue(chat.beginEditingQueued(id: id))
        try await waitFor("the hold") { FakeHubProtocol.snapshot()[1].heldBy == "iPhone" }
        chat.queuedEditDraft = "Wednesday"
        XCTAssertTrue(chat.saveQueuedEdit())
        try await waitFor("the save") { FakeHubProtocol.snapshot()[1].text == "Wednesday" }
        XCTAssertTrue(FakeHubProtocol.calls().contains("PATCH /conversations/supervisor/queue/ios-edit-0001 Wednesday"))

        // Someone else changed it meanwhile: this phone's save is refused.
        XCTAssertTrue(chat.beginEditingQueued(id: id))
        try await waitFor("the second hold") { FakeHubProtocol.calls().filter { $0 == "PATCH /conversations/supervisor/queue/ios-edit-0001" }.count == 2 }
        try await Task.sleep(for: .milliseconds(100))
        FakeHubProtocol.set { $0[1].text = "Thursday (from the Mac)"; $0[1].revision = 5 }
        chat.queuedEditDraft = "Friday"
        XCTAssertTrue(chat.saveQueuedEdit())
        try await waitFor("the refusal") { chat.queuedSubmissions.first?.origin?.error != nil }
        XCTAssertEqual(chat.queuedSubmissions.first?.text, "Thursday (from the Mac)", "what the hub has, not the refused edit")
        XCTAssertTrue(chat.queuedSubmissions.first?.origin?.error?.contains("changed on another device") == true)
    }

    @MainActor
    func testAMessageBeingEditedOnAnotherDeviceCannotBeEditedRemovedOrSentNowHere() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-4", text: "busy", source: "Mac", mine: false, state: "running", revision: 1),
                                    .init(requestId: "mac-held-0001", text: "being edited", source: "Mac", mine: false, state: "held", heldBy: "Mac", revision: 1)] }
        let chat = await chat()
        let item = try XCTUnwrap(chat.queuedSubmissions.first)
        XCTAssertEqual(item.origin?.heldBy, "Mac")
        XCTAssertFalse(chat.beginEditingQueued(id: item.id))
        XCTAssertFalse(chat.canSendQueuedNow(id: item.id))
    }

    @MainActor
    func testRemoveAndSendNowAreHubRequestsForAnyDevicesMessage() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-5", text: "busy", source: "Mac", mine: false, state: "running", revision: 1),
                                    .init(requestId: "mac-remove-01", text: "remove me", source: "Mac", mine: false, state: "queued", revision: 1),
                                    .init(requestId: "mac-first-001", text: "send me now", source: "Mac", mine: false, state: "queued", revision: 1)] }
        let chat = await chat()
        chat.removeQueuedSubmission(id: chat.queuedSubmissions[0].id)
        try await waitFor("the removal on the hub") { !FakeHubProtocol.snapshot().contains { $0.requestId == "mac-remove-01" } }
        XCTAssertTrue(FakeHubProtocol.calls().contains { $0.hasPrefix("DELETE /conversations/supervisor/queue/mac-remove-01") })

        await chat.sendQueuedNow(id: chat.queuedSubmissions[0].id)
        XCTAssertTrue(FakeHubProtocol.calls().contains("POST /conversations/supervisor/queue/mac-first-001/send-now"))
        XCTAssertEqual(chat.queuedSubmissions.first?.sendNow, .answered(.interrupted))
        XCTAssertFalse(FakeHubProtocol.calls().contains { $0.hasPrefix("POST /conversations/supervisor/interrupt") }, "the hub chooses what to stop")
    }
}
