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
    // Accept the next queued message but hold the answer until released.
    nonisolated(unsafe) static var holdNextEnqueue = false
    private struct Held: @unchecked Sendable { let proto: FakeHubProtocol; let runLoop: CFRunLoop }
    nonisolated(unsafe) private static var heldEnqueue: Held?

    static func reset() { lock.withLock { items = []; log = []; failNextEnqueue = false; sendNowStatus = "interrupted"; holdNextEnqueue = false; heldEnqueue = nil } }
    static var isHoldingEnqueue: Bool { lock.withLock { heldEnqueue != nil } }
    static func releaseEnqueue() {
        guard let held = lock.withLock({ () -> Held? in defer { heldEnqueue = nil }; return heldEnqueue }) else { return }
        let proto = held.proto
        let json = lock.withLock { queueJSON() }
        CFRunLoopPerformBlock(held.runLoop, CFRunLoopMode.commonModes.rawValue) { proto.respond(202, ["queue": json]) }
        CFRunLoopWakeUp(held.runLoop)
    }
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

    fileprivate func respond(_ status: Int, _ object: Any, type: String = "application/json") {
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
        Self.log.append("\(method) \(path)" + (body["text"].map { " \($0)" } ?? "") + (body["requestId"].map { " #\($0)" } ?? "")
                        + ((body["next"] as? Bool) == true ? " NEXT" : ""))
        if path == "/conversations/supervisor/messages" { return respond(200, ["messages": [], "queue": Self.queueJSON()]) }
        if path == "/conversations/supervisor/queue", method == "POST" {
            if Self.failNextEnqueue {
                Self.failNextEnqueue = false
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            let id = body["requestId"] as? String ?? ""
            var sendNow: [String: Any]? = nil
            if !Self.items.contains(where: { $0.requestId == id }) {
                let item = Item(requestId: id, text: body["text"] as? String ?? "", source: "iPhone", mine: true, state: "queued", heldBy: nil, revision: 1)
                if (body["next"] as? Bool) == true, let runningIndex = Self.items.firstIndex(where: { $0.state == "running" }) {
                    // Send anyway: the running reply stops, this goes next.
                    Self.items.remove(at: runningIndex)
                    Self.items.insert(item, at: 0)
                    sendNow = ["status": "interrupted"]
                } else if (body["next"] as? Bool) == true {
                    Self.items.insert(item, at: 0)
                    sendNow = ["status": "next"]
                } else {
                    Self.items.append(item)
                }
            }
            if Self.holdNextEnqueue {
                Self.holdNextEnqueue = false
                Self.heldEnqueue = Held(proto: self, runLoop: CFRunLoopGetCurrent())
                return
            }
            var answer: [String: Any] = ["requestId": id, "queue": Self.queueJSON()]
            if let sendNow { answer["sendNow"] = sendNow }
            return respond(202, answer)
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

    @MainActor
    func testASaveNamesTheRevisionTheEditorOpenedAtEvenIfANewerOneArrivesWhileEditing() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-6", text: "busy", source: "Mac", mine: false, state: "running", revision: 1),
                                    .init(requestId: "ios-stale-0001", text: "Tuesday", source: "iPhone", mine: true, state: "queued", revision: 2)] }
        let chat = await chat()
        let id = try XCTUnwrap(chat.queuedSubmissions.first?.id)
        XCTAssertTrue(chat.beginEditingQueued(id: id))
        // Another device edits it before this phone's hold lands: the hold's
        // own answer brings revision 5 into this phone's queue.
        FakeHubProtocol.set { $0[1].text = "Thursday (Mac)"; $0[1].revision = 5 }
        try await waitFor("the hold answer") { chat.queuedSubmissions.first?.origin?.revision == 5 }
        chat.queuedEditDraft = "Wednesday"
        XCTAssertTrue(chat.saveQueuedEdit())
        try await waitFor("the refusal") { chat.queuedSubmissions.first?.origin?.error != nil }
        XCTAssertEqual(FakeHubProtocol.snapshot()[1].text, "Thursday (Mac)", "the other device's edit was not overwritten")
        XCTAssertEqual(chat.queuedSubmissions.first?.text, "Thursday (Mac)")
    }

    @MainActor
    func testRemovingAMessageWhileItsUploadIsOnTheWireRemovesItOnTheHubToo() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-7", text: "busy", source: "Mac", mine: false, state: "running", revision: 1)] }
        let chat = await chat()
        FakeHubProtocol.holdNextEnqueue = true
        chat.draft = "changed my mind"
        XCTAssertTrue(chat.submitDraft())
        try await waitFor("the hub to take it, answer pending") { FakeHubProtocol.isHoldingEnqueue }
        let id = try XCTUnwrap(chat.queuedSubmissions.first?.id)
        let requestID = try XCTUnwrap(chat.queuedSubmissions.first?.requestID)
        chat.removeQueuedSubmission(id: id)
        XCTAssertTrue(chat.queuedSubmissions.isEmpty)
        FakeHubProtocol.releaseEnqueue()
        try await waitFor("the hub removal") { !FakeHubProtocol.snapshot().contains { $0.requestId == requestID } }
        XCTAssertTrue(FakeHubProtocol.calls().contains { $0.hasPrefix("DELETE /conversations/supervisor/queue/\(requestID)") })
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(chat.queuedSubmissions.isEmpty, "the upload's answer did not bring it back")
    }

    @MainActor
    func testAMessageNotYetOnTheHubIsNeverUploadedWithItsOldTextWhileItsEditorIsOpen() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-8", text: "busy", source: "Mac", mine: false, state: "running", revision: 1)] }
        let chat = await chat()
        FakeHubProtocol.failNextEnqueue = true
        chat.draft = "old text"
        XCTAssertTrue(chat.submitDraft())
        try await waitFor("the failed upload") { FakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") }.count == 1 }
        let id = try XCTUnwrap(chat.queuedSubmissions.first?.id)
        XCTAssertTrue(chat.beginEditingQueued(id: id))
        await chat.refresh()   // the connection is back; a retry would run now
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(FakeHubProtocol.calls().filter { $0.hasPrefix("POST /conversations/supervisor/queue") }.count, 1, "held while editing")
        chat.queuedEditDraft = "new text"
        XCTAssertTrue(chat.saveQueuedEdit())
        try await waitFor("the upload of the edited text") { FakeHubProtocol.snapshot().contains { $0.text == "new text" } }
        XCTAssertFalse(FakeHubProtocol.snapshot().contains { $0.text == "old text" })
    }

    @MainActor
    private func chat(preference: BusySendBehavior) async throws -> ChatConversation {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "busy-\(UUID().uuidString)"))
        preference.store(in: defaults)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeHubProtocol.self]
        let client = DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:test", token: "synthetic-token",
                                  session: URLSession(configuration: config))
        let conversation = ChatConversation(thread: .supervisor, client: client,
                                            store: ChatHistoryStore(thread: "busy-\(UUID().uuidString)", directory: directory),
                                            nodeID: "mobile:test", preferences: defaults)
        await conversation.refresh()
        return conversation
    }

    @MainActor
    func testWhileBusyTheDefaultQueuesAndSendAnywayStopsTheReplyAndGoesNextAheadOfTheQueue() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-9", text: "Mac's long reply", source: "Mac", mine: false, state: "running", revision: 1),
                                    .init(requestId: "mac-queued-9", text: "Mac queued earlier", source: "Mac", mine: false, state: "queued", revision: 1)] }
        let chat = try await chat(preference: .queue)
        XCTAssertEqual(chat.busySendBehavior, .queue, "the default")
        chat.draft = "queued by default"
        XCTAssertTrue(chat.submitDraft())
        try await waitFor("the queued message") { FakeHubProtocol.snapshot().contains { $0.text == "queued by default" } }
        XCTAssertTrue(FakeHubProtocol.calls().contains { $0.contains("queued by default") && !$0.hasSuffix("NEXT") })

        chat.draft = "send anyway"
        XCTAssertTrue(chat.submitDraft(override: .sendNow))
        XCTAssertEqual(chat.queuedSubmissions.first?.text, "send anyway", "shown first at once")
        XCTAssertEqual(chat.queuedSubmissions.first?.sendNow, .requesting)
        try await waitFor("the hub's answer") { chat.queuedSubmissions.first?.sendNow == .answered(.interrupted) }
        XCTAssertTrue(FakeHubProtocol.calls().contains { $0.contains("send anyway") && $0.hasSuffix("NEXT") }, "one request: queue, next, stop")
        XCTAssertEqual(FakeHubProtocol.snapshot().map(\.text), ["send anyway", "Mac queued earlier", "queued by default"],
                       "it goes next; the others keep their order")
        XCTAssertFalse(FakeHubProtocol.calls().contains { $0.hasPrefix("POST /message") })
    }

    @MainActor
    func testTheSendImmediatelyPreferenceAndAQueueInsteadOverride() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-10", text: "busy", source: "Mac", mine: false, state: "running", revision: 1)] }
        let chat = try await chat(preference: .sendNow)
        chat.draft = "queue this one instead"
        XCTAssertTrue(chat.submitDraft(override: .queue))
        try await waitFor("the queued one") { FakeHubProtocol.snapshot().contains { $0.text == "queue this one instead" } }
        XCTAssertTrue(FakeHubProtocol.calls().contains { $0.contains("queue this one instead") && !$0.hasSuffix("NEXT") })
        chat.draft = "send immediately"
        XCTAssertTrue(chat.submitDraft())
        try await waitFor("the immediate one") { FakeHubProtocol.calls().contains { $0.contains("send immediately") && $0.hasSuffix("NEXT") } }
    }

    @MainActor
    func testWhenNothingIsRunningSendJustSendsWhateverThePreference() async throws {
        let chat = try await chat(preference: .sendNow)
        XCTAssertFalse(chat.isBusy)
        chat.draft = "plain send"
        XCTAssertTrue(chat.submitDraft(override: .sendNow))
        try await waitFor("the normal send") { FakeHubProtocol.calls().contains { $0.hasPrefix("POST /message") } }
        XCTAssertFalse(FakeHubProtocol.calls().contains { $0.hasPrefix("POST /conversations/supervisor/queue") })
    }
}
