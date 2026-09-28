import XCTest
@testable import OpenAGI

// The routes this phase added, against `StubProtocol` (DaemonClientTests.swift):
// what each request sends, and how `ChatConversation` behaves end to end --
// sending into a shared thread, merging the daemon's history, surviving a
// relaunch, and degrading on a main from before shared threads.
final class SharedConversationClientTests: XCTestCase {
    private nonisolated(unsafe) static var requests: [URLRequest] = []
    private var directory: URL!

    override func setUpWithError() throws {
        Self.requests = []
        StubProtocol.failure = nil
        directory = FileManager.default.temporaryDirectory.appending(path: "chat-client-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeClient() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(
            server: URL(string: "http://mac.tail1234.ts.net:43210")!,
            nodeID: "mobile:abc",
            token: String(repeating: "a", count: 43),
            session: URLSession(configuration: config)
        )
    }

    // Routes by path; records every request so a test can find the one it cares about.
    private func stub(_ routes: [String: (Int, String)]) {
        StubProtocol.handler = { request in
            Self.requests.append(request)
            let (status, body) = routes[request.url?.path ?? ""] ?? (404, #"{"error":"not found"}"#)
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
    }

    private func body(of request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        } ?? request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func request(path: String) throws -> URLRequest {
        try XCTUnwrap(Self.requests.last(where: { $0.url?.path == path }), "no request to \(path)")
    }

    private let replyStream = "event: delta\ndata: {\"text\":\"Hi\",\"reset\":false}\n\nevent: final\ndata: {\"reply\":\"Hi there\"}\n\n"

    // MARK: - DaemonClient requests

    func testConversationMessagesRequestsTheThreadPage() async throws {
        stub(["/conversations/supervisor/messages": (200, #"{"thread":"supervisor","messages":[],"nextBefore":null}"#)])
        let page = try await makeClient().conversationMessages(thread: .supervisor, before: "m9", limit: 500)
        XCTAssertTrue(page.messages.isEmpty)
        let sent = try request(path: "/conversations/supervisor/messages")
        XCTAssertEqual(sent.httpMethod, "GET")
        let query = URLComponents(url: sent.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "100")
        XCTAssertEqual(query.first(where: { $0.name == "before" })?.value, "m9")
    }

    func testConversationMessagesOnAnOlderMainIsNotFound() async {
        stub([:])
        do {
            _ = try await makeClient().conversationMessages(thread: .agent)
            XCTFail("expected a throw")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .notFound)
        } catch { XCTFail("unexpected \(error)") }
    }

    func testLifelogMomentsSendsDateAndQuery() async throws {
        stub(["/lifelog/moments": (200, #"{"moments":[{"id":"life-1","title":"Standup"}]}"#)])
        let moments = try await makeClient().lifelogMoments(date: "2026-09-28", query: "  ana  ")
        XCTAssertEqual(moments.map(\.id), ["life-1"])
        let query = URLComponents(url: try request(path: "/lifelog/moments").url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "date" })?.value, "2026-09-28")
        XCTAssertEqual(query.first(where: { $0.name == "query" })?.value, "ana")
    }

    func testLifelogMomentsOmitsAnEmptyQuery() async throws {
        stub(["/lifelog/moments": (200, #"{"moments":[]}"#)])
        _ = try await makeClient().lifelogMoments(date: "2026-09-28", query: " ")
        let names = URLComponents(url: try request(path: "/lifelog/moments").url!, resolvingAgainstBaseURL: false)?
            .queryItems?.map(\.name) ?? []
        XCTAssertFalse(names.contains("query"))
    }

    func testFleetMutationsSendTheContractBodies() async throws {
        let state = #"{"mode":"propose"}"#
        stub([
            "/fleet/api/mode": (200, state),
            "/fleet/api/questions/q1": (200, #"{"delivery":{"status":"sent"},"state":{"mode":"propose"}}"#),
            "/fleet/api/actions/a1/send": (200, #"{"delivery":{"status":"sent"}}"#),
        ])
        let client = makeClient()
        let fresh = try await client.fleetSetMode(.propose)
        XCTAssertEqual(fresh.mode, "propose")
        XCTAssertEqual(try body(of: try request(path: "/fleet/api/mode"))["mode"] as? String, "propose")

        let answered = try await client.fleetAnswer(questionID: "q1", answer: "merge")
        XCTAssertEqual(answered.delivery?.status, "sent")
        XCTAssertEqual(try body(of: try request(path: "/fleet/api/questions/q1"))["answer"] as? String, "merge")

        _ = try await client.fleetDismiss(questionID: "q1")
        XCTAssertEqual(try body(of: try request(path: "/fleet/api/questions/q1"))["dismiss"] as? Bool, true)

        let sent = try await client.fleetSendAction(id: "a1")
        XCTAssertEqual(sent.delivery?.status, "sent")
        XCTAssertEqual(try request(path: "/fleet/api/actions/a1/send").httpMethod, "POST")
    }

    func testFleetOnADaemonWithoutASupervisorMapsToUnavailable() async {
        stub(["/fleet/api/state": (503, #"{"error":"fleet supervisor disabled"}"#)])
        do {
            _ = try await makeClient().fleetState()
            XCTFail("expected a throw")
        } catch let error as DaemonError {
            XCTAssertTrue(SupervisorFormat.isUnavailable(error))
            XCTAssertEqual(SupervisorFormat.errorCopy(error).headline, "Supervisor isn't running on this daemon.")
        } catch { XCTFail("unexpected \(error)") }
    }

    // MARK: - ChatConversation

    @MainActor
    func testChatSendsIntoTheAgentThreadAndPersists() async throws {
        stub(["/message": (200, replyStream), "/conversations/agent/messages": (404, "{}")])
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        let conversation = ChatConversation(thread: .agent, client: makeClient(), store: store, nodeID: "mobile:abc")
        await conversation.send("  hello  ")

        let sent = try body(of: try request(path: "/message"))
        XCTAssertEqual(sent["text"] as? String, "hello")
        XCTAssertEqual(sent["thread"] as? String, "agent")
        XCTAssertNil(sent["from"])
        XCTAssertEqual(conversation.messages.map(\.text), ["hello", "Hi there"])
        // An older main: the phone's own copy stays, and the screen says why
        // the glasses can't see it.
        XCTAssertEqual(conversation.historyStatus, .needsUpdate)
        XCTAssertEqual(store.load(nodeID: "mobile:abc").map(\.text), ["hello", "Hi there"])

        // A relaunch reads the same conversation back.
        let relaunched = ChatConversation(thread: .agent, client: makeClient(), store: store, nodeID: "mobile:abc")
        XCTAssertEqual(relaunched.messages.map(\.id), conversation.messages.map(\.id))
    }

    @MainActor
    func testSupervisorChatAlsoKeepsItsLegacyConversationKey() async throws {
        stub(["/message": (200, replyStream), "/conversations/supervisor/messages": (404, "{}")])
        let conversation = ChatConversation(thread: .supervisor, client: makeClient(),
                                            store: ChatHistoryStore(thread: "supervisor", directory: directory), nodeID: "mobile:abc")
        await conversation.send("What's running?")
        let sent = try body(of: try request(path: "/message"))
        XCTAssertEqual(sent["thread"] as? String, "supervisor")
        XCTAssertEqual(sent["from"] as? String, "mobile-supervisor")
        XCTAssertEqual(sent["sessionId"] as? String, "mobile-supervisor")
    }

    @MainActor
    func testRefreshMergesTheSharedThreadAndSavesIt() async throws {
        stub(["/conversations/agent/messages": (200, """
        {"thread":"agent","messages":[
          {"id":"m1","role":"user","text":"From the glasses","at":"2026-09-28T15:40:00Z","sourceNodeId":"g2:1","sourceName":"Spencer's G2"},
          {"id":"m2","role":"assistant","text":"**Done.**","at":"2026-09-28T15:40:05Z","sourceNodeId":null,"sourceName":null}
        ],"nextBefore":null}
        """)])
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        let conversation = ChatConversation(thread: .agent, client: makeClient(), store: store, nodeID: "mobile:abc")
        await conversation.refresh()
        XCTAssertEqual(conversation.historyStatus, .synced)
        XCTAssertEqual(conversation.messages.map(\.serverID), ["m1", "m2"])
        XCTAssertEqual(store.load(nodeID: "mobile:abc").map(\.serverID), ["m1", "m2"])
    }

    @MainActor
    func testAStreamThatEndsWithoutAReplySaysItStopped() async throws {
        stub(["/message": (200, "event: delta\ndata: {\"text\":\"Hal\",\"reset\":false}\n\n"),
              "/conversations/agent/messages": (404, "{}")])
        let conversation = ChatConversation(thread: .agent, client: makeClient(),
                                            store: ChatHistoryStore(thread: "agent", directory: directory), nodeID: "mobile:abc")
        await conversation.send("hello")
        XCTAssertEqual(conversation.messages.last?.text, "Reply stopped early. Try again.")
        XCTAssertTrue(conversation.messages.last?.isFailed ?? false)
    }

    @MainActor
    func testForgetClearsTheCacheAndBlocksLateWrites() async throws {
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        store.save(nodeID: "mobile:abc", entries: [SavedChatEntry(id: UUID(), role: "user", at: Date(), text: "old")])
        let conversation = ChatConversation(thread: .agent, client: makeClient(), store: store, nodeID: "mobile:abc")
        XCTAssertEqual(conversation.messages.count, 1)
        conversation.forget()
        conversation.persist()
        XCTAssertTrue(conversation.messages.isEmpty)
        XCTAssertEqual(store.load(nodeID: "mobile:abc"), [])
    }
}
