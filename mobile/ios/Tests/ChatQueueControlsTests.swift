import XCTest
import SupervisorChannelsKit
@testable import OpenAGI

// Queued-message controls against a main whose reply streams stay open until
// the test says so: Edit never sends, Remove keeps order, and Send Now
// interrupts the running reply, then sends the chosen message next. The
// status shown is only what main answered.
final class HeldStreamProtocol: URLProtocol, @unchecked Sendable {
    struct Sent: Equatable { let text: String; let requestId: String? }
    private struct Held: @unchecked Sendable { let proto: HeldStreamProtocol; let runLoop: CFRunLoop }
    static let lock = NSLock()
    nonisolated(unsafe) private static var held: [String: Held] = [:]
    nonisolated(unsafe) static var hold: Set<String> = []
    nonisolated(unsafe) static var sent: [Sent] = []
    nonisolated(unsafe) static var interrupts: [String] = []
    // requestId of the turn to stop -> (status code, JSON body). Runs on the
    // loader thread; may call `release`.
    nonisolated(unsafe) static var answerInterrupt: (@Sendable (String) -> (Int, String))?
    nonisolated(unsafe) static var heartbeatStatus = 200
    // What GET .../messages answers (main's shared history).
    nonisolated(unsafe) static var history = "{\"messages\":[]}"

    static func reset() {
        lock.withLock {
            held = [:]; hold = []; sent = []; interrupts = []
            answerInterrupt = nil; heartbeatStatus = 200; history = "{\"messages\":[]}"
        }
    }
    static var sentTexts: [String] { lock.withLock { sent.map(\.text) } }
    static var sentTurns: [Sent] { lock.withLock { sent } }
    static var interruptCount: Int { lock.withLock { interrupts.count } }
    static var interruptIDs: [String] { lock.withLock { interrupts } }
    static func isHeld(_ text: String) -> Bool { lock.withLock { held[text] != nil } }

    // Sends the rest of a held stream and ends it.
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

    private func body() -> [String: Any] {
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
        let path = request.url!.path
        if path == "/message" {
            let body = body()
            let text = body["text"] as? String ?? ""
            let requestId = body["requestId"] as? String
            let shouldHold = Self.lock.withLock {
                Self.sent.append(Sent(text: text, requestId: requestId))
                return Self.hold.contains(text)
            }
            if shouldHold {
                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                               headerFields: ["Content-Type": "text/event-stream"])!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data("event: session\ndata: {\"id\":\"devices:supervisor:main\",\"messageCount\":1}\n\n".utf8))
                Self.lock.withLock { Self.held[text] = Held(proto: self, runLoop: CFRunLoopGetCurrent()) }
            } else {
                respond(200, "event: final\ndata: {\"reply\":\"Ack: \(text)\"}\n\n", type: "text/event-stream")
            }
            return
        }
        if path.hasSuffix("/interrupt") {
            let requestId = body()["requestId"] as? String ?? ""
            let answer = Self.lock.withLock { () -> (@Sendable (String) -> (Int, String))? in
                Self.interrupts.append(requestId)
                return Self.answerInterrupt
            }
            let (status, json) = answer?(requestId) ?? (404, "{\"error\":\"not_found\"}")
            respond(status, json)
            return
        }
        if path == "/nodes/heartbeat" {
            respond(Self.lock.withLock { Self.heartbeatStatus }, "{}")
            return
        }
        respond(200, Self.lock.withLock { Self.history })
    }

    override func stopLoading() {}
}

final class ChatQueueControlsTests: XCTestCase {
    private var directory: URL!
    private static let stopped = "event: failure\ndata: {\"code\":\"stopped\",\"error\":\"Stopped so your next message could go first.\"}\n\n"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "chat-queue-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        HeldStreamProtocol.reset()
    }

    override func tearDownWithError() throws {
        HeldStreamProtocol.reset()
        try FileManager.default.removeItem(at: directory)
    }

    @MainActor
    private func conversation() -> ChatConversation {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HeldStreamProtocol.self]
        let client = DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:test",
                                  token: "synthetic-token", session: URLSession(configuration: config))
        return ChatConversation(thread: .supervisor, client: client,
                                store: ChatHistoryStore(thread: "queue-\(UUID().uuidString)", directory: directory), nodeID: "mobile:test")
    }

    @MainActor
    private func waitFor(_ what: String, timeout: Duration = .seconds(5), _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline { XCTFail("Timed out waiting for \(what)"); return }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    // A running reply plus queued messages, in the order typed.
    @MainActor
    private func busy(_ chat: ChatConversation, running: String, queued: [String]) async throws {
        HeldStreamProtocol.hold.insert(running)
        chat.draft = running
        XCTAssertTrue(chat.submitDraft())
        for text in queued {
            chat.draft = text
            XCTAssertTrue(chat.submitDraft(), "Send while busy queues")
        }
        try await waitFor("the running reply to reach main") { HeldStreamProtocol.isHeld(running) }
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), queued)
    }

    @MainActor
    func testSendNowInterruptsTheReplyAndSendsTheChosenMessageNextKeepingTheRestInOrder() async throws {
        let chat = conversation()
        try await busy(chat, running: "Plan Tuesday", queued: ["Also invite Sam", "Actually make it Wednesday", "Book a room"])
        let runningTurn = HeldStreamProtocol.sentTurns[0].requestId
        HeldStreamProtocol.answerInterrupt = { requestId in
            HeldStreamProtocol.release("Plan Tuesday", frames: Self.stopped)
            return (200, "{\"status\":\"interrupted\",\"requestId\":\"\(requestId)\"}")
        }
        let correction = chat.queuedSubmissions[1]

        await chat.sendQueuedNow(id: correction.id)
        try await waitFor("the queue to drain") { !chat.isSending }

        XCTAssertEqual(HeldStreamProtocol.interruptIDs, [runningTurn!], "main is asked to stop exactly the running reply")
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Plan Tuesday", "Actually make it Wednesday", "Also invite Sam", "Book a room"])
        XCTAssertEqual(HeldStreamProtocol.sentTurns[1].requestId, correction.requestID, "a queued message keeps its turn id")
        XCTAssertEqual(Set(HeldStreamProtocol.sentTurns.compactMap(\.requestId)).count, 4, "nothing sent twice")
        let stoppedReply = try XCTUnwrap(chat.messages.first { $0.role == .assistant })
        XCTAssertEqual(stoppedReply.text, ChatConversation.stoppedText)
        XCTAssertFalse(stoppedReply.isFailed, "a stop the owner asked for is not a failure to retry")
        XCTAssertFalse(stoppedReply.isStreaming)
    }

    @MainActor
    func testADoubleTapSendsOneInterrupt() async throws {
        let chat = conversation()
        try await busy(chat, running: "Long task", queued: ["Correction"])
        HeldStreamProtocol.answerInterrupt = { requestId in
            Thread.sleep(forTimeInterval: 0.1)
            return (200, "{\"status\":\"stopping\",\"tool\":\"send_email\",\"requestId\":\"\(requestId)\"}")
        }
        let id = chat.queuedSubmissions[0].id
        async let first: Void = chat.sendQueuedNow(id: id)
        async let second: Void = chat.sendQueuedNow(id: id)
        _ = await (first, second)
        XCTAssertEqual(HeldStreamProtocol.interruptCount, 1)
        XCTAssertEqual(chat.queuedSubmissions[0].sendNow, .answered(.stopping(tool: "send_email")))
        XCTAssertTrue(chat.queuedSubmissions[0].sendNow!.label.contains("won't be undone"))
        XCTAssertFalse(chat.canSendQueuedNow(id: id), "it already goes next")

        // The running tool finishes, the turn stops, and the correction goes.
        HeldStreamProtocol.release("Long task", frames: Self.stopped)
        try await waitFor("the queue to drain") { !chat.isSending }
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Long task", "Correction"])
    }

    @MainActor
    func testAnOlderMainIsReportedAsUnableToInterruptAndTheMessageWaitsForTheReply() async throws {
        let chat = conversation()
        try await busy(chat, running: "Question", queued: ["First queued", "Chosen"])
        // Old main: the phone's unknown route is a 401; the heartbeat proves
        // the pairing is fine.
        HeldStreamProtocol.answerInterrupt = { _ in (401, "{\"error\":\"unauthorized\"}") }
        let chosen = chat.queuedSubmissions[1].id
        await chat.sendQueuedNow(id: chosen)
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Chosen", "First queued"])
        XCTAssertEqual(chat.queuedSubmissions[0].sendNow, .answered(.unsupported))
        XCTAssertFalse(chat.queuedSubmissions[0].sendNow!.label.hasPrefix("Reply stopped"))
        XCTAssertTrue(HeldStreamProtocol.isHeld("Question"), "nothing pretended to stop it")

        HeldStreamProtocol.release("Question", frames: "event: final\ndata: {\"reply\":\"Full answer\"}\n\n")
        try await waitFor("the queue to drain") { !chat.isSending }
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Question", "Chosen", "First queued"])
        XCTAssertEqual(chat.messages.first { $0.role == .assistant }?.text, "Full answer")
    }

    @MainActor
    func testAReplyThatFinishedFirstIsNotCalledInterruptedAndAFailedRequestCanBeRetried() async throws {
        let chat = conversation()
        try await busy(chat, running: "Quick", queued: ["Next"])
        let id = chat.queuedSubmissions[0].id
        HeldStreamProtocol.answerInterrupt = { _ in (503, "{\"error\":\"busy\"}") }
        await chat.sendQueuedNow(id: id)
        XCTAssertEqual(chat.queuedSubmissions[0].sendNow, .answered(.unreachable))
        XCTAssertTrue(chat.canSendQueuedNow(id: id), "an unanswered interrupt can be tried again")

        HeldStreamProtocol.answerInterrupt = { requestId in
            HeldStreamProtocol.release("Quick", frames: "event: final\ndata: {\"reply\":\"Done already\"}\n\n")
            return (200, "{\"status\":\"finished\",\"outcome\":\"complete\",\"requestId\":\"\(requestId)\"}")
        }
        await chat.sendQueuedNow(id: id)
        try await waitFor("the queue to drain") { !chat.isSending }
        XCTAssertEqual(HeldStreamProtocol.interruptCount, 2)
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Quick", "Next"])
        XCTAssertEqual(chat.messages.first { $0.role == .assistant }?.text, "Done already", "the finished reply is kept")
    }

    @MainActor
    func testEditingHoldsTheQueueAndNeverSendsTheOldTextOrJumpsAhead() async throws {
        let chat = conversation()
        try await busy(chat, running: "Running", queued: ["Typo here", "After it"])
        let typo = chat.queuedSubmissions[0].id
        XCTAssertTrue(chat.beginEditingQueued(id: typo))
        XCTAssertFalse(chat.canSendQueuedNow(id: typo), "an open edit cannot be sent now")

        HeldStreamProtocol.release("Running", frames: "event: final\ndata: {\"reply\":\"ok\"}\n\n")
        try await waitFor("the running reply to end") { !chat.isSending }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Running"], "the queue waits at the open edit")

        // A new message while the queue waits goes after it, not ahead.
        chat.draft = "Typed meanwhile"
        XCTAssertTrue(chat.submitDraft())
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Typo here", "After it", "Typed meanwhile"])
        XCTAssertFalse(chat.isSending)

        chat.queuedEditDraft = "   "
        XCTAssertFalse(chat.saveQueuedEdit(), "a blank edit is refused")
        chat.queuedEditDraft = "Typo fixed"
        XCTAssertTrue(chat.saveQueuedEdit())
        try await waitFor("the queue to drain") { chat.queuedSubmissions.isEmpty && !chat.isSending }
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Running", "Typo fixed", "After it", "Typed meanwhile"])
    }

    @MainActor
    func testSendNowStopsTheReplyMainIsStillRunningAfterItsStreamDroppedAndTheCorrectionGoesNext() async throws {
        let chat = conversation()
        try await busy(chat, running: "Long job", queued: ["Queued behind it", "Correction"])
        let longJob = try XCTUnwrap(HeldStreamProtocol.sentTurns[0].requestId)
        // The stream drops after main accepted the turn: main keeps working.
        HeldStreamProtocol.lock.withLock {
            HeldStreamProtocol.history = "{\"messages\":[],\"inFlight\":[{\"requestId\":\"\(longJob)\",\"stage\":\"model\"}]}"
        }
        HeldStreamProtocol.release("Long job", frames: "")
        try await waitFor("the reply to detach") { chat.messages.contains { $0.isDetached && $0.requestID == longJob } }
        try await Task.sleep(for: .milliseconds(200))
        // The queue waits here, not behind the running turn on main.
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Long job"], "nothing is sent behind a turn main still runs")
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Queued behind it", "Correction"])

        // Send Now on the correction stops the turn main is running.
        HeldStreamProtocol.answerInterrupt = { requestId in
            // Main has stored the stop for that turn.
            HeldStreamProtocol.history = "{\"messages\":[{\"id\":\"u1\",\"role\":\"user\",\"text\":\"Long job\",\"at\":\"2026-11-25T00:00:00Z\",\"requestId\":\"\(requestId)\"},{\"id\":\"a1\",\"role\":\"assistant\",\"text\":\"Stopped so your next message could go first.\",\"at\":\"2026-11-25T00:00:01Z\",\"requestId\":\"\(requestId)\",\"status\":\"failed\"}],\"inFlight\":[]}"
            return (200, "{\"status\":\"interrupted\",\"requestId\":\"\(requestId)\"}")
        }
        await chat.sendQueuedNow(id: chat.queuedSubmissions[1].id)
        XCTAssertEqual(HeldStreamProtocol.interruptIDs, [longJob], "stop the turn main is running")
        try await waitFor("the queue to drain") { chat.queuedSubmissions.isEmpty && !chat.isSending }
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Long job", "Correction", "Queued behind it"],
                       "the correction goes first; the message queued earlier keeps its place behind it")
    }

    @MainActor
    func testRemovingTheMessageBeingSentNowLeavesTheRestInOrder() async throws {
        let chat = conversation()
        try await busy(chat, running: "Running", queued: ["A", "B", "C"])
        HeldStreamProtocol.answerInterrupt = { requestId in (200, "{\"status\":\"stopping\",\"requestId\":\"\(requestId)\"}") }
        let b = chat.queuedSubmissions[1].id
        await chat.sendQueuedNow(id: b)
        chat.removeQueuedSubmission(id: b)
        HeldStreamProtocol.release("Running", frames: Self.stopped)
        try await waitFor("the queue to drain") { chat.queuedSubmissions.isEmpty && !chat.isSending }
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Running", "A", "C"])
    }

    @MainActor
    func testSendAnywayOnAMainWithoutAQueueStopsTheRunningReplyAndSendsNextAheadOfEarlierQueuedMessages() async throws {
        let chat = conversation()
        try await busy(chat, running: "Long reply", queued: ["Queued earlier"])
        let running = try XCTUnwrap(HeldStreamProtocol.sentTurns[0].requestId)
        HeldStreamProtocol.answerInterrupt = { requestId in
            HeldStreamProtocol.release("Long reply", frames: Self.stopped)
            return (200, "{\"status\":\"interrupted\",\"requestId\":\"\(requestId)\"}")
        }
        chat.draft = "Do this instead, now"
        XCTAssertTrue(chat.submitDraft(override: .sendNow))
        try await waitFor("the queue to drain") { !chat.isSending && chat.queuedSubmissions.isEmpty }
        XCTAssertEqual(HeldStreamProtocol.interruptIDs, [running])
        XCTAssertEqual(HeldStreamProtocol.sentTexts, ["Long reply", "Do this instead, now", "Queued earlier"])
    }
}
