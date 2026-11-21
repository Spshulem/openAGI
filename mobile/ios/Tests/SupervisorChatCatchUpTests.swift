import XCTest
import os
@testable import OpenAGI

// Inbound catch-up for the Supervisor chat (thread "supervisor"): the phone
// locks or loses the network during a long reply, or is relaunched mid-turn.
// On return the reply is found in `/conversations/supervisor/messages` by its
// turn id, the working line clears, nothing shows twice, and the question is
// never sent again. Synthetic daemon only.
final class SupervisorChatCatchUpTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "supervisor-catch-up-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        CatchUpDaemon.reset()
    }

    override func tearDownWithError() throws {
        CatchUpDaemon.reset()
        try FileManager.default.removeItem(at: directory)
    }

    private func client() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CatchUpDaemon.self]
        return DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:catch-up",
                            token: "synthetic-token", session: URLSession(configuration: config))
    }

    @MainActor private func model() -> AppModel {
        let credential = Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:catch-up", token: "synthetic-token")
        return AppModel(credentials: credential, client: client(), store: SnapshotStore(directory: directory),
                        queue: OutboundQueue(directory: directory), chatDirectory: directory)
    }

    @MainActor private func supervisorChat(_ client: DaemonClient? = nil) -> ChatConversation {
        ChatConversation(thread: .supervisor, client: client ?? self.client(),
                         store: ChatHistoryStore(thread: "supervisor", directory: directory), nodeID: "mobile:catch-up")
    }

    @MainActor private func until(_ what: String, _ check: () -> Bool) async throws {
        for _ in 0..<800 where !check() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(check(), what)
    }

    // The reply is mid-stream: accepted by main, some text shown.
    @MainActor private func startLongReply(_ chat: ChatConversation) async throws {
        Task { await chat.send("How is the fleet?") }
        try await until("the reply streams") { chat.messages.last?.text == "Checking the fleet" }
        XCTAssertTrue(chat.isSending)
        XCTAssertTrue(try XCTUnwrap(chat.messages.last).accepted)
    }

    @MainActor private func assertSettled(_ chat: ChatConversation, reply: String, file: StaticString = #filePath, line: UInt = #line) {
        let shown = chat.messages.map { [$0.role == .user ? "user" : "assistant", $0.text] }
        XCTAssertEqual(shown, [["user", "How is the fleet?"], ["assistant", reply]], "one question, one reply", file: file, line: line)
        XCTAssertFalse(chat.messages.contains { $0.isStreaming || $0.isDetached || $0.activity != nil }, "the working line cleared", file: file, line: line)
        XCTAssertFalse(chat.isSending, file: file, line: line)
        XCTAssertEqual(CatchUpDaemon.posts(), 1, "the question was never sent again", file: file, line: line)
    }

    @MainActor
    func testLockMidReplyWhileItIsStillRunningCatchesUpOnReturn() async throws {
        CatchUpDaemon.state.withLock { $0.stream = .hangs }
        let app = model()
        let chat = app.supervisorChat
        try await startLongReply(chat)
        let posted = try XCTUnwrap(CatchUpDaemon.lastBody())
        XCTAssertEqual(posted["thread"] as? String, "supervisor")
        XCTAssertEqual(posted["requestId"] as? String, chat.messages.last?.requestID)

        // Locked: app-wide, though no Supervisor screen is mounted here.
        app.conversations.enterBackground()
        try await until("the dead stream is let go") { !chat.isSending }
        let working = try XCTUnwrap(chat.messages.last)
        XCTAssertTrue(working.isDetached && working.isStreaming)
        XCTAssertEqual(working.activity, ChatHistoryCodec.stillWorking)
        XCTAssertEqual(working.text, "Checking the fleet", "what arrived stays")
        XCTAssertEqual(CatchUpDaemon.reads(), 0, "away, nothing polls")

        CatchUpDaemon.state.withLock { $0.history = .running }
        app.conversations.resumeOpenChats()
        try await until("back, it reads the supervisor history") { CatchUpDaemon.reads() > 0 && chat.historyStatus == .synced }
        XCTAssertTrue(try XCTUnwrap(chat.messages.last).isDetached, "main says it is still running")
        XCTAssertEqual(chat.messages.filter { $0.role == .assistant }.count, 1)

        CatchUpDaemon.state.withLock { $0.history = .finished }
        try await until("recovery polling finds the reply") { chat.messages.last?.text == "Fleet is green." }
        assertSettled(chat, reply: "Fleet is green.")
    }

    @MainActor
    func testReturningAfterTheReplyFinishedShowsItOnce() async throws {
        CatchUpDaemon.state.withLock { $0.stream = .hangs }
        let app = model()
        let chat = app.supervisorChat
        try await startLongReply(chat)
        app.conversations.enterBackground()
        try await until("the dead stream is let go") { !chat.isSending }

        CatchUpDaemon.state.withLock { $0.history = .finished }
        app.conversations.resumeOpenChats()
        try await until("the stored reply replaces the working line") { chat.messages.last?.text == "Fleet is green." }
        assertSettled(chat, reply: "Fleet is green.")
    }

    @MainActor
    func testANetworkDropMidReplyRecoversFromHistoryWithoutResending() async throws {
        CatchUpDaemon.state.withLock {
            $0.stream = .drops
            $0.history = .running
        }
        let chat = supervisorChat()
        Task { await chat.send("How is the fleet?") }
        try await until("the dropped reply is waited on") { chat.messages.last?.isDetached == true && !chat.isSending }
        XCTAssertEqual(chat.messages.last?.activity, ChatHistoryCodec.stillWorking)

        CatchUpDaemon.state.withLock { $0.history = .finished }
        try await until("recovery polling finds the reply") { chat.messages.last?.text == "Fleet is green." }
        assertSettled(chat, reply: "Fleet is green.")
    }

    @MainActor
    func testRelaunchMidTurnRecoversAndNeverResends() async throws {
        CatchUpDaemon.state.withLock { $0.stream = .hangs }
        let first = supervisorChat()
        try await startLongReply(first)
        first.persist()
        first.suspend() // the process is gone; its stream with it

        CatchUpDaemon.state.withLock { $0.history = .finished }
        let relaunched = supervisorChat()
        XCTAssertTrue(try XCTUnwrap(relaunched.messages.last).isDetached, "saved as still coming, not stopped")
        await relaunched.resume()
        assertSettled(relaunched, reply: "Fleet is green.")
    }

    @MainActor
    func testAFailureMainStoredWhileAwayReplacesTheWorkingLine() async throws {
        CatchUpDaemon.state.withLock { $0.stream = .hangs }
        let app = model()
        let chat = app.supervisorChat
        try await startLongReply(chat)
        app.conversations.enterBackground()
        try await until("the dead stream is let go") { !chat.isSending }

        CatchUpDaemon.state.withLock { $0.history = .failed }
        app.conversations.resumeOpenChats()
        try await until("main's failure record shows") { chat.messages.last?.text == "I couldn't reach the model." }
        assertSettled(chat, reply: "I couldn't reach the model.")
    }

    // A refresh (foreground, `/events`) can land while this phone's own
    // stream is still open but main already stored the reply.
    func testAStillStreamingPlaceholderMainAlreadyAnsweredIsNotShownTwice() {
        let now = Date()
        var user = ChatMessage(role: .user, text: "How is the fleet?", timestamp: now)
        user.requestID = "ios-sup-1"
        var reply = ChatMessage(role: .assistant, text: "Checking the fleet", isStreaming: true, timestamp: now)
        reply.requestID = "ios-sup-1"
        reply.accepted = true
        let server = [
            ConversationMessage(id: "m1", role: .user, text: "How is the fleet?", at: now, requestId: "ios-sup-1"),
            ConversationMessage(id: "m2", role: .assistant, text: "Fleet is green.", at: now, requestId: "ios-sup-1"),
        ]
        let merged = ChatHistoryMerge.merge(local: [user, reply], server: server)
        XCTAssertEqual(merged.map(\.text), ["How is the fleet?", "Fleet is green."])
        XCTAssertEqual(merged.first?.id, user.id)
        XCTAssertFalse(merged.contains(where: \.isStreaming))

        let stillRunning = ChatHistoryMerge.merge(local: [user, reply], server: [server[0]])
        XCTAssertEqual(stillRunning.map(\.text), ["How is the fleet?", "Checking the fleet"], "not answered yet: it keeps streaming")
    }
}

// A synthetic daemon: `/message` streams a reply that then hangs (a socket
// iOS cut while locked) or drops; the supervisor history says what main has.
final class CatchUpDaemon: URLProtocol {
    enum Stream: Sendable { case hangs, drops }
    enum History: Sendable { case empty, running, finished, failed }
    struct State: Sendable {
        var stream: Stream = .hangs
        var history: History = .empty
        var requestID: String?
        var messagePosts = 0
        // Reads of `/conversations/supervisor/messages` only.
        var historyReads = 0
        var lastBodyData: Data?
    }
    static let state = OSAllocatedUnfairLock(initialState: State())
    static func reset() { state.withLock { $0 = State() } }
    static func posts() -> Int { state.withLock { $0.messagePosts } }
    static func reads() -> Int { state.withLock { $0.historyReads } }
    static func lastBody() -> [String: Any]? {
        state.withLock { $0.lastBodyData }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        if url.path == "/message" {
            let body = Self.body(request)
            let id = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["requestId"] as? String
            let mode = Self.state.withLock { state -> Stream in
                state.messagePosts += 1
                state.lastBodyData = body
                state.requestID = id
                return state.stream
            }
            // The content type matters: without it URLSession holds the
            // first bytes back to sniff one, and a hung stream shows nothing.
            let sse = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                      headerFields: ["Content-Type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: sse, cacheStoragePolicy: .notAllowed)
            let frames = """
            event: status\ndata: {"stage":"queued"}\n\n\
            event: session\ndata: {"id":"devices:supervisor:main","messageCount":1}\n\n\
            event: delta\ndata: {"text":"Checking the fleet","reset":false}\n\n
            """
            client?.urlProtocol(self, didLoad: Data(frames.utf8))
            if mode == .drops {
                // Later, as a real drop is: an error at once can overtake
                // bytes the client has not read yet.
                let client = self.client
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [self] in
                    client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                }
            }
            return // `.hangs`: never finishes, never fails.
        }
        // Only the supervisor thread has this turn; every other chat is empty.
        let page = url.path != "/conversations/supervisor/messages"
            ? #"{"messages":[],"nextBefore":null,"inFlight":[]}"#
            : Self.state.withLock { state -> String in
                state.historyReads += 1
                return Self.page(state.history, id: state.requestID ?? "none")
            }
        client?.urlProtocol(self, didReceive: ok, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(page.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func page(_ history: History, id: String) -> String {
        let user = #"{"id":"m1","role":"user","text":"How is the fleet?","at":"2030-01-01T10:00:00.000Z","requestId":"\#(id)"}"#
        switch history {
        case .empty:
            return #"{"thread":"supervisor","messages":[],"nextBefore":null,"inFlight":[]}"#
        case .running:
            return #"{"thread":"supervisor","messages":[\#(user)],"nextBefore":null,"inFlight":[{"requestId":"\#(id)","stage":"model"}]}"#
        case .finished:
            return #"{"thread":"supervisor","messages":[\#(user),{"id":"m2","role":"assistant","text":"Fleet is green.","at":"2030-01-01T10:00:05.000Z","requestId":"\#(id)"}],"nextBefore":null,"inFlight":[]}"#
        case .failed:
            return #"{"thread":"supervisor","messages":[\#(user),{"id":"m2","role":"assistant","text":"I couldn't reach the model.","at":"2030-01-01T10:00:05.000Z","requestId":"\#(id)","status":"failed"}],"nextBefore":null,"inFlight":[]}"#
        }
    }

    private static func body(_ request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count <= 0 { break }
            data.append(bytes, count: count)
        }
        return data
    }
}
