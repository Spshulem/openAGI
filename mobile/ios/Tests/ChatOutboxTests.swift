import XCTest
@testable import OpenAGI

// The durable outbox (ChatConversation): reconnecting must never fire the
// owner's queued messages at main in a burst. One turn at a time, each only
// after main finished the previous one; a send whose answer was lost is
// asked about (`GET /conversations/:thread/turns`) before it ever goes
// again. Synthetic data only, against a fake main.
final class ChatOutboxTests: XCTestCase {
    private var directory: URL!
    private var main: FakeMain!
    private static let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQKHgAAAI8AXnXjkfVAAAAAElFTkSuQmCC"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "chat-outbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        main = FakeMain()
        OutboxStubProtocol.main = main
    }

    override func tearDownWithError() throws {
        OutboxStubProtocol.main = nil
        try? FileManager.default.removeItem(at: directory)
    }

    private func client() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OutboxStubProtocol.self]
        return DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:test",
                            token: "synthetic-token", session: URLSession(configuration: config))
    }

    private var store: ChatHistoryStore { ChatHistoryStore(thread: "supervisor", directory: directory) }

    @MainActor
    private func conversation() -> ChatConversation {
        ChatConversation(thread: .supervisor, client: client(), store: store, nodeID: "mobile:test")
    }

    @MainActor
    private func submit(_ conversation: ChatConversation, _ text: String, attachments: [ChatAttachment] = []) {
        conversation.draft = text
        conversation.draftAttachments = attachments
        XCTAssertTrue(conversation.submitDraft())
    }

    @MainActor
    private func waitUntilIdle(_ conversation: ChatConversation) async throws {
        for _ in 0..<300 where conversation.isSending { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(conversation.isSending)
    }

    // MARK: - Draining

    @MainActor
    func testQueuedMessagesDrainOneAtATimeInOrder() async throws {
        let chat = conversation()
        submit(chat, "First")
        submit(chat, "Second")
        submit(chat, "Third")
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Second", "Third"], "the first is already in the conversation")
        XCTAssertEqual(chat.queuedSubmissions.map { chat.displayState(of: $0) }, [.queued, .queued])
        try await waitUntilIdle(chat)

        let posts = main.posts
        XCTAssertEqual(posts.map(\.text), ["First", "Second", "Third"], "one /message per item, in order")
        XCTAssertEqual(Set(posts.map(\.requestId)).count, 3)
        XCTAssertEqual(main.maxConcurrentPosts, 1, "never two turns at once")
        XCTAssertTrue(chat.queuedSubmissions.isEmpty)
        XCTAssertEqual(store.loadOutbox(nodeID: "mobile:test"), [])
        XCTAssertEqual(chat.messages.filter { $0.role == .assistant }.map(\.text), ["Ack: First", "Ack: Second", "Ack: Third"])
    }

    @MainActor
    func testIdenticalTextSentTwiceIsTwoTurns() async throws {
        let chat = conversation()
        submit(chat, "Same words")
        submit(chat, "Same words")
        try await waitUntilIdle(chat)
        let posts = main.posts
        XCTAssertEqual(posts.map(\.text), ["Same words", "Same words"])
        XCTAssertNotEqual(posts[0].requestId, posts[1].requestId)
    }

    // MARK: - A lost stream pauses the queue

    @MainActor
    func testADetachedTurnPausesTheQueueUntilMainSaysItIsDone() async throws {
        main.replies = [.sessionThenDrop]
        let chat = conversation()
        submit(chat, "Plan my day")
        submit(chat, "Then book lunch")
        submit(chat, "And email Dana")
        try await waitUntilIdle(chat)
        XCTAssertEqual(main.posts.count, 1, "the rest wait behind the turn main is still running")
        XCTAssertTrue(chat.messages.last?.isDetached == true)
        XCTAssertEqual(chat.queuedSubmissions.map { chat.displayState(of: $0) }, [.waiting, .waiting])

        // Back in the foreground: main is still running it.
        await chat.resume()
        XCTAssertEqual(main.posts.count, 1)
        XCTAssertGreaterThan(main.turnsQueries, 0)

        // Main finished it: the next one goes, and only after it the last.
        main.finish(main.posts[0].requestId, reply: "Here's your day.")
        await chat.resume()
        try await waitUntilIdle(chat)
        XCTAssertEqual(main.posts.map(\.text), ["Plan my day", "Then book lunch", "And email Dana"])
        XCTAssertEqual(main.maxConcurrentPosts, 1)
        XCTAssertTrue(chat.messages.contains { $0.text == "Here's your day." })
        XCTAssertTrue(chat.queuedSubmissions.isEmpty)
        chat.pauseRecovery()
    }

    @MainActor
    func testQueuedItemsSurviveARelaunchAndResumeWithTheirIdsAndImages() async throws {
        main.replies = [.sessionThenDrop]
        let image = ChatAttachment(name: "Synthetic.png", mimeType: "image/png", data: Self.png, thumbnail: Self.png)
        let first = conversation()
        submit(first, "Plan my day")
        submit(first, "Look at this", attachments: [image])
        submit(first, "Last one")
        try await waitUntilIdle(first)
        let queuedIDs = first.queuedSubmissions.map(\.requestID)
        XCTAssertEqual(queuedIDs.count, 2)
        // The process dies.
        first.suspend()

        main.finish(main.posts[0].requestId, reply: "Here's your day.")
        let relaunched = conversation()
        XCTAssertEqual(relaunched.queuedSubmissions.map(\.text), ["Look at this", "Last one"])
        XCTAssertEqual(relaunched.queuedSubmissions.first?.attachments.first?.data, Self.png, "full image data survives")
        await relaunched.resume()
        try await waitUntilIdle(relaunched)

        let posts = main.posts
        XCTAssertEqual(posts.map(\.text), ["Plan my day", "Look at this", "Last one"])
        XCTAssertEqual(Array(posts.dropFirst().map(\.requestId)), queuedIDs, "the ids named at Send")
        XCTAssertEqual(posts[1].imageData, [Self.png], "sent with its image, not without it")
        XCTAssertTrue(relaunched.queuedSubmissions.isEmpty)
        relaunched.pauseRecovery()
    }

    @MainActor
    func testAnImageThatCannotBeRestoredFailsTheItemInsteadOfSendingWithoutIt() async throws {
        store.saveOutbox(nodeID: "mobile:test", items: [
            SavedOutboxItem(id: UUID(), requestID: "ios-synthetic-1", text: "Look", attachments: [ChatAttachment(name: "Lost", data: nil)],
                            focusedCardID: nil, createdAt: Date(), state: "queued", maybeDelivered: false)
        ])
        let chat = conversation()
        await chat.resume()
        XCTAssertEqual(main.posts.count, 0)
        let item = try XCTUnwrap(chat.queuedSubmissions.first)
        XCTAssertEqual(chat.displayState(of: item), .failed(ChatConversation.missingImageText))
        XCTAssertFalse(item.canRetry)
    }

    // MARK: - A send whose answer was lost

    @MainActor
    func testALostAcknowledgementIsNeverResentWhenMainHasTheTurn() async throws {
        // Main got it, but the connection died before any frame came back.
        main.replies = [.failAfterAccepting]
        let chat = conversation()
        submit(chat, "Plan my day")
        submit(chat, "Then book lunch")
        try await waitUntilIdle(chat)
        XCTAssertEqual(main.posts.count, 1)
        XCTAssertTrue(chat.messages.isEmpty)
        XCTAssertEqual(chat.queuedSubmissions.map(\.state), [.notSent, .queued], "only the one that was sent is in doubt")

        await chat.resume()
        XCTAssertEqual(main.posts.count, 1, "running on main: followed, not resent")
        XCTAssertTrue(chat.messages.last?.isDetached == true)
        XCTAssertEqual(chat.queuedSubmissions.map(\.text), ["Then book lunch"])

        main.finish(main.posts[0].requestId, reply: "Here's your day.")
        await chat.resume()
        try await waitUntilIdle(chat)
        XCTAssertEqual(main.posts.map(\.text), ["Plan my day", "Then book lunch"])
        XCTAssertEqual(chat.messages.filter { $0.text == "Plan my day" }.count, 1, "one copy of the question")
        chat.pauseRecovery()
    }

    @MainActor
    func testALostAcknowledgementForAFinishedTurnJustShowsTheReply() async throws {
        main.replies = [.failAfterAccepting]
        let chat = conversation()
        submit(chat, "Plan my day")
        try await waitUntilIdle(chat)
        main.finish(main.posts[0].requestId, reply: "Here's your day.")

        await chat.resume()
        XCTAssertEqual(main.posts.count, 1)
        XCTAssertTrue(chat.queuedSubmissions.isEmpty)
        XCTAssertEqual(chat.messages.map(\.text), ["Plan my day", "Here's your day."])
    }

    @MainActor
    func testATurnMainNeverGotIsResentOnceWithTheSameId() async throws {
        main.replies = [.drop]
        let chat = conversation()
        submit(chat, "Plan my day")
        try await waitUntilIdle(chat)
        XCTAssertEqual(chat.queuedSubmissions.first?.state, .notSent)

        await chat.resume()
        try await waitUntilIdle(chat)
        let posts = main.posts
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts[0].requestId, posts[1].requestId, "main dedupes by id")
        XCTAssertEqual(chat.messages.last?.text, "Ack: Plan my day")
        await chat.resume()
        XCTAssertEqual(main.posts.count, 2)
    }

    @MainActor
    func testOfflineOnlyTheItemThatWasTriedIsInDoubt() async throws {
        main.replies = [.fail]
        let chat = conversation()
        submit(chat, "One")
        submit(chat, "Two")
        submit(chat, "Three")
        try await waitUntilIdle(chat)
        XCTAssertEqual(main.posts.count, 1)
        XCTAssertEqual(chat.queuedSubmissions.map(\.state), [.notSent, .queued, .queued])
        XCTAssertFalse(chat.messages.contains(where: \.isFailed), "no burst of Not sent lines")
    }

    @MainActor
    func testAnOlderMainWithoutTheTurnsRouteNeverAutoResendsAnAmbiguousItem() async throws {
        main.turnsRouteMissing = true
        main.replies = [.drop]
        let chat = conversation()
        submit(chat, "Plan my day")
        submit(chat, "Then book lunch")
        try await waitUntilIdle(chat)

        await chat.resume()
        await chat.resume()
        XCTAssertEqual(main.posts.count, 1, "no blind resend")
        let item = try XCTUnwrap(chat.queuedSubmissions.first)
        XCTAssertEqual(chat.displayState(of: item), .failed(ChatConversation.unconfirmedItemText))
        XCTAssertTrue(item.canRetry)
        XCTAssertFalse(item.isEditable)

        // The person checked and chose Retry: same id, then the rest.
        chat.retryQueuedSubmission(id: item.id)
        try await waitUntilIdle(chat)
        let posts = main.posts
        XCTAssertEqual(posts.map(\.text), ["Plan my day", "Plan my day", "Then book lunch"])
        XCTAssertEqual(posts[0].requestId, posts[1].requestId)
    }

    // MARK: - Lines saved before the outbox (#316 format)

    @MainActor
    private func saveLegacyUnconfirmedLine(id: String) {
        var user = ChatMessage(role: .user, text: "Legacy question")
        user.requestID = id
        var reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        reply.requestID = id
        store.save(nodeID: "mobile:test", entries: [ChatHistoryCodec.saved(user), ChatHistoryCodec.saved(reply)])
    }

    @MainActor
    func testALegacyUnconfirmedLineIsCheckedBeforeItIsResent() async throws {
        saveLegacyUnconfirmedLine(id: "ios-legacy-1")
        main.turnsRouteMissing = true
        let chat = conversation()
        XCTAssertTrue(chat.messages.last?.autoRetry == true)
        await chat.resume()
        XCTAssertEqual(main.posts.count, 0, "an older main cannot say: never resent on its own")
        XCTAssertEqual(chat.messages.last?.autoRetry, false)
        XCTAssertEqual(chat.messages.last?.text, ChatConversation.connectionLostText)
    }

    @MainActor
    func testALegacyUnconfirmedLineMainNeverGotIsResentOnceAndThenTheQueueGoes() async throws {
        saveLegacyUnconfirmedLine(id: "ios-legacy-2")
        let chat = conversation()
        submit(chat, "Queued after it")
        XCTAssertEqual(main.posts.count, 0, "waits until the older send is settled")
        await chat.resume()
        try await waitUntilIdle(chat)
        let posts = main.posts
        XCTAssertEqual(posts.map(\.requestId).first, "ios-legacy-2")
        XCTAssertEqual(posts.map(\.text), ["Legacy question", "Queued after it"])
        await chat.resume()
        XCTAssertEqual(main.posts.count, 2)
    }

    @MainActor
    func testConcurrentResumesCheckAndSendOnce() async throws {
        main.replies = [.drop]
        let chat = conversation()
        submit(chat, "Plan my day")
        try await waitUntilIdle(chat)
        async let one: Void = chat.resume()
        async let two: Void = chat.resume()
        _ = await (one, two)
        try await waitUntilIdle(chat)
        XCTAssertEqual(main.posts.count, 2, "the first try and exactly one resend")
    }

    // MARK: - DaemonClient

    func testTurnsRouteSendsIdsAndConversationAndDecodes() async throws {
        main.turnStates = ["ios-a": "running", "ios-b": "done"]
        let answer = try await client().conversationTurns(thread: .supervisor, ids: ["ios-a", "ios-b", "ios-c"], conversationId: "c1")
        XCTAssertEqual(answer.turns, [ConversationTurnStatus(requestId: "ios-a", state: .running),
                                      ConversationTurnStatus(requestId: "ios-b", state: .done),
                                      ConversationTurnStatus(requestId: "ios-c", state: .unknown)])
        let query = try XCTUnwrap(main.lastTurnsQuery)
        XCTAssertEqual(query["ids"], "ios-a,ios-b,ios-c")
        XCTAssertEqual(query["conversationId"], "c1")
    }

    func testTurnsRouteOnAnOlderMainIsNotFoundAndUnknownStatesAreDropped() async throws {
        main.turnsRouteMissing = true
        do {
            _ = try await client().conversationTurns(thread: .supervisor, ids: ["ios-a"])
            XCTFail("expected a throw")
        } catch let error as DaemonError { XCTAssertEqual(error, .notFound) }
        let json = #"{"turns":[{"requestId":"a","state":"teleported"},{"requestId":"b","state":"queued","code":"x"}]}"#
        let decoded = try ProtocolDecoder.json.decode(ConversationTurns.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.turns, [ConversationTurnStatus(requestId: "b", state: .queued, code: "x")])
    }
}

// A main that remembers what it was sent. Each POST answers with the next
// scripted reply (default: accept and finish with "Ack: <text>").
final class FakeMain: @unchecked Sendable {
    enum Reply {
        case final
        // Accepted (`session`), then the connection drops: main keeps going.
        case sessionThenDrop
        // 200 with nothing: the connection went before main confirmed it,
        // and main never got it.
        case drop
        // A transport error before any byte, and main never got it.
        case fail
        // A transport error before any byte, but main did get it.
        case failAfterAccepting
    }

    struct Post { let requestId: String; let text: String; let imageData: [String] }

    private let lock = NSLock()
    private var _posts: [Post] = []
    private var _replies: [Reply] = []
    private var _turnStates: [String: String] = [:]
    private var _turnsRouteMissing = false
    private var _turnsQueries = 0
    private var _lastTurnsQuery: [String: String]?
    private var history: [String] = []
    private var inFlight: [String] = []
    private var activePosts = 0
    private var _maxConcurrentPosts = 0

    var posts: [Post] { lock.withLock { _posts } }
    var turnsQueries: Int { lock.withLock { _turnsQueries } }
    var maxConcurrentPosts: Int { lock.withLock { _maxConcurrentPosts } }
    var lastTurnsQuery: [String: String]? { lock.withLock { _lastTurnsQuery } }
    var replies: [Reply] {
        get { lock.withLock { _replies } }
        set { lock.withLock { _replies = newValue } }
    }
    var turnStates: [String: String] {
        get { lock.withLock { _turnStates } }
        set { lock.withLock { _turnStates = newValue } }
    }
    var turnsRouteMissing: Bool {
        get { lock.withLock { _turnsRouteMissing } }
        set { lock.withLock { _turnsRouteMissing = newValue } }
    }

    // The turn ended on main: its question and reply are in history.
    func finish(_ requestId: String, reply: String) {
        lock.withLock {
            let text = _posts.first(where: { $0.requestId == requestId })?.text ?? ""
            let now = Date()
            history.append(Self.line(id: "m\(history.count + 1)", role: "user", text: text, at: now, requestId: requestId))
            history.append(Self.line(id: "m\(history.count + 1)", role: "assistant", text: reply, at: now.addingTimeInterval(1), requestId: requestId))
            inFlight.removeAll { $0 == requestId }
            _turnStates[requestId] = "done"
        }
    }

    enum Answer { case response(Int, String); case failure }

    func handle(_ request: URLRequest) -> Answer {
        let path = request.url?.path ?? ""
        switch path {
        case "/message":
            let body = Self.body(of: request)
            let requestId = body["requestId"] as? String ?? ""
            let text = body["text"] as? String ?? ""
            let images = (body["attachments"] as? [[String: Any]] ?? []).compactMap { $0["data"] as? String }
            let reply: Reply = lock.withLock {
                _posts.append(Post(requestId: requestId, text: text, imageData: images))
                activePosts += 1
                _maxConcurrentPosts = max(_maxConcurrentPosts, activePosts)
                return _replies.isEmpty ? .final : _replies.removeFirst()
            }
            // Long enough that a second, overlapping POST would be seen.
            Thread.sleep(forTimeInterval: 0.02)
            return lock.withLock {
                activePosts -= 1
                let session = "event: session\ndata: {\"id\":\"devices:supervisor:main\",\"messageCount\":1,\"requestId\":\"\(requestId)\"}\n\n"
                switch reply {
                case .final:
                    _turnStates[requestId] = "done"
                    return .response(200, session + "event: final\ndata: {\"reply\":\"Ack: \(text)\"}\n\n")
                case .sessionThenDrop:
                    _turnStates[requestId] = "running"
                    inFlight.append(requestId)
                    return .response(200, session)
                case .drop:
                    return .response(200, "")
                case .fail:
                    return .failure
                case .failAfterAccepting:
                    _turnStates[requestId] = "running"
                    inFlight.append(requestId)
                    return .failure
                }
            }
        case "/conversations/supervisor/turns":
            return lock.withLock {
                _turnsQueries += 1
                if _turnsRouteMissing { return .response(404, #"{"error":"not found"}"#) }
                let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                var query: [String: String] = [:]
                for item in items { query[item.name] = item.value }
                _lastTurnsQuery = query
                let ids = (query["ids"] ?? "").split(separator: ",").map(String.init)
                let turns = ids.map { #"{"requestId":"\#($0)","state":"\#(_turnStates[$0] ?? "unknown")"}"# }
                return .response(200, #"{"thread":"supervisor","conversationId":"main","active":[],"turns":[\#(turns.joined(separator: ","))]}"#)
            }
        case "/conversations/supervisor/messages":
            return lock.withLock {
                let running = inFlight.map { #"{"requestId":"\#($0)","stage":"model"}"# }
                return .response(200, #"{"thread":"supervisor","messages":[\#(history.joined(separator: ","))],"nextBefore":null,"inFlight":[\#(running.joined(separator: ","))]}"#)
            }
        case "/mobile/capabilities":
            return .response(200, #"{"imageAttachments":true}"#)
        default:
            return .response(404, #"{"error":"not found"}"#)
        }
    }

    private static func line(id: String, role: String, text: String, at: Date, requestId: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return #"{"id":"\#(id)","role":"\#(role)","text":"\#(text)","at":"\#(formatter.string(from: at))","requestId":"\#(requestId)"}"#
    }

    private static func body(of request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
}

final class OutboxStubProtocol: URLProtocol {
    nonisolated(unsafe) static var main: FakeMain?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let main = Self.main else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        switch main.handle(request) {
        case .failure:
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        case .response(let status, let body):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
