import XCTest
@testable import OpenAGI

final class ConversationLibraryTests: XCTestCase {
    private var directory: URL!
    private let id = "7caf4a12-0155-4c2d-8d14-f7972b8f43a1"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "conversation-library-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        StubProtocol.failure = nil
    }

    override func tearDownWithError() throws {
        StubProtocol.handler = nil
        try FileManager.default.removeItem(at: directory)
    }

    @MainActor private func model(server: String = "https://daemon.example.com") -> AppModel {
        let credential = Credentials(server: URL(string: server)!, nodeID: "mobile:library-test", token: "synthetic-test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = DaemonClient(server: credential.server, nodeID: credential.nodeID, token: credential.token,
                                  session: URLSession(configuration: configuration))
        return AppModel(credentials: credential, client: client, store: SnapshotStore(directory: directory),
                        queue: OutboundQueue(directory: directory), chatDirectory: directory)
    }

    @MainActor func testNamedChatsKeepIndependentDraftsAndSurviveCatalogReloadWithoutCrossingServerScope() async throws {
        let record = """
        {"id":"\(id)","thread":"agent","title":"A named chat","preview":"A saved answer","updatedAt":"2026-10-27T10:00:00Z","messageCount":2,"readOnly":false}
        """
        StubProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: request.httpMethod == "POST" ? 201 : 200, httpVersion: nil, headerFields: nil)!
            return (response, Data((request.httpMethod == "POST" ? record : "{\"conversations\":[\(record)]}").utf8))
        }
        let first = model()
        first.agentChat.draft = "Shared draft"
        let created = await first.conversations.create(thread: .agent)
        XCTAssertTrue(created)
        let named = first.conversations.selected(.agent)
        XCTAssertEqual(named.conversationID, id)
        XCTAssertEqual(named.draft, "")
        named.draft = "Private next draft"
        XCTAssertEqual(first.agentChat.draft, "Shared draft")
        XCTAssertTrue(first.conversations.selected(.supervisor) === first.supervisorChat)
        let reloaded = model()
        XCTAssertEqual(reloaded.conversations.summaries.first?.id, id)
        reloaded.conversations.select(try XCTUnwrap(reloaded.conversations.summaries.first))
        XCTAssertEqual(reloaded.conversations.selected(.agent).conversationID, id)
        XCTAssertTrue(model(server: "https://another.example.com").conversations.summaries.isEmpty)
    }

    @MainActor func testReadOnlyWebHistoryCannotSendAndOldServersCannotRedirectNewChatsToTheDefault() async throws {
        let client = model().client
        let readOnly = ChatConversation(thread: .agent, client: client, store: ChatHistoryStore(thread: "web-test", directory: directory),
                                        nodeID: "mobile:library-test", conversationID: "web-test", isReadOnly: true)
        readOnly.draft = "Continue"
        XCTAssertFalse(readOnly.submitDraft())
        XCTAssertTrue(readOnly.messages.isEmpty)
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!, Data("{\"error\":\"node message contains unsupported fields\"}".utf8))
        }
        do {
            _ = try await client.sendMessageStreaming(text: "Never redirect", thread: .agent, conversationId: id)
            XCTFail("An old server must reject a named chat")
        } catch { XCTAssertEqual(error as? DaemonError, .notFound) }
    }

    @MainActor func testSetupAnswersPairingQuestionsWithoutRunningActionsOrCollectingKeys() async {
        let guide = SetupGuide(availability: .unsupported)
        guide.draft = "Where do I get a pairing code?"
        await guide.send()
        XCTAssertEqual(guide.draft, "")
        XCTAssertTrue(guide.messages.last?.text.contains("Nodes → Connect a phone") == true)
        guide.draft = "sk-synthetic-not-a-real-key"
        await guide.send()
        XCTAssertFalse(guide.messages.contains { $0.text.contains("sk-synthetic") })
        XCTAssertTrue(guide.messages.last?.text.contains("Model Settings") == true)
    }
}
