import XCTest
import ImageIO
import os
@testable import OpenAGI

final class ChatSubmissionTests: XCTestCase {
    private var directory: URL!
    private static let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQKHgAAAI8AXnXjkfVAAAAAElFTkSuQmCC"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "chat-submission-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        StubProtocol.failure = nil
    }

    override func tearDownWithError() throws {
        StubProtocol.handler = nil
        StubProtocol.failure = nil
        try FileManager.default.removeItem(at: directory)
    }

    private func client() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:test",
                            token: "synthetic-token", session: URLSession(configuration: config))
    }

    private static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(bytes, count: count)
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    func testSubmitResetsEditorAndImagesSynchronouslyAndPreservesTheNextDraftInBothThreads() async throws {
        let prepared = try await ChatAttachmentPreparation.prepare(Data(base64Encoded: Self.png)!, name: "Synthetic.png")
        for thread in ConversationThread.allCases {
            let delivered = OSAllocatedUnfairLock(initialState: 0)
            StubProtocol.handler = { request in
                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                if request.url!.path == "/mobile/capabilities" {
                    return (response, Data(#"{"imageAttachments":true}"#.utf8))
                }
                if request.url!.path == "/message" {
                    guard let body = try? Self.body(request),
                          let attachments = body["attachments"] as? [[String: Any]] else {
                        XCTFail("The chat request must contain its image attachments")
                        return (response, Data())
                    }
                    XCTAssertEqual(body["thread"] as? String, thread.rawValue)
                    XCTAssertEqual(body["text"] as? String, "Look at this")
                    XCTAssertEqual(attachments.first?["data"] as? String, prepared.data)
                    XCTAssertEqual(attachments.first?["mimeType"] as? String, "image/jpeg")
                    delivered.withLock { $0 += 1 }
                    return (response, Data("event: final\ndata: {\"reply\":\"Image received\"}\n\n".utf8))
                }
                return (response, Data("{\"messages\":[]}".utf8))
            }
            let conversation = ChatConversation(thread: thread, client: client(),
                store: ChatHistoryStore(thread: thread.rawValue, directory: directory), nodeID: "mobile:test")
            conversation.draft = "Look at this"
            conversation.draftAttachments = [prepared]
            XCTAssertTrue(conversation.submitDraft())
            XCTAssertEqual(conversation.draft, "")
            XCTAssertTrue(conversation.draftAttachments.isEmpty)
            XCTAssertTrue(conversation.isSending)
            XCTAssertEqual(conversation.composerRevision, 1)
            XCTAssertFalse(conversation.submitDraft(), "Two Send/Return events cannot start two turns")
            conversation.draft = "Next message"
            for _ in 0..<100 where conversation.isSending { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertFalse(conversation.isSending)
            XCTAssertEqual(delivered.withLock { $0 }, 1)
            XCTAssertEqual(conversation.draft, "Next message", "An older reply must not clear the next draft")
            XCTAssertEqual(conversation.messages.last?.text, "Image received")
        }
    }

    @MainActor
    func testImageOnlyDraftCanSendAndCacheRetainsOnlySmallPreviews() async throws {
        let prepared = try await ChatAttachmentPreparation.prepare(Data(base64Encoded: Self.png)!, name: "Synthetic.png")
        let message = ChatMessage(role: .user, text: "Image", attachments: [prepared])
        let saved = ChatHistoryCodec.saved(message)
        XCTAssertNil(saved.attachments?.first?.data)
        XCTAssertEqual(saved.attachments?.first?.thumbnail, prepared.thumbnail)
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        store.save(nodeID: "mobile:test", entries: [saved])
        XCTAssertEqual(store.load(nodeID: "mobile:test").first?.attachments?.first?.id, prepared.id)
        let conversation = ChatConversation(thread: .agent, client: client(), store: store, nodeID: "mobile:test")
        XCTAssertFalse(conversation.canSubmitDraft)
        conversation.draftAttachments = [prepared]
        XCTAssertTrue(conversation.canSubmitDraft)
        conversation.forget()
        XCTAssertTrue(conversation.draftAttachments.isEmpty)
    }

    func testOlderMainNeverRetriesAnImageRequestWithoutItsPixels() async throws {
        nonisolated(unsafe) var count = 0
        StubProtocol.handler = { request in
            if request.url!.path == "/mobile/capabilities" {
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                        Data(#"{"imageAttachments":true}"#.utf8))
            }
            count += 1
            return (HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!,
                    Data("{\"error\":\"node message contains unsupported fields\"}".utf8))
        }
        do {
            _ = try await client().sendMessageStreaming(text: "Look", thread: .supervisor,
                attachments: [ChatAttachment(name: "Synthetic", mimeType: "image/png", data: Self.png)])
            XCTFail("An old server must explicitly reject image upload")
        } catch let error as DaemonError { XCTAssertEqual(error, .imagesUnsupported) }
        XCTAssertEqual(count, 1, "Never retry with only text or silently discard the attachment")
    }

    func testImagePreflightNeverUploadsToALegacyMainThatRejectsOnlyTheCapabilityRoute() async {
        nonisolated(unsafe) var paths: [String] = []
        StubProtocol.handler = { request in
            let path = request.url!.path
            paths.append(path)
            XCTAssertNotEqual(path, "/message", "Unsupported uploads must never start a turn")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:test")
            let status = path == "/nodes/heartbeat" ? 200 : 401
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        do {
            _ = try await client().sendMessageStreaming(text: "Look", thread: .agent,
                attachments: [ChatAttachment(name: "Synthetic", mimeType: "image/png", data: Self.png)])
            XCTFail("The upload must stop before posting pixels")
        } catch { XCTAssertEqual(error as? DaemonError, .imagesUnsupported) }
        XCTAssertEqual(paths, ["/mobile/capabilities", "/nodes/heartbeat"])
    }

    @MainActor func testRejectedChatRequestIsNotReportedAsADroppedStream() async throws {
        StubProtocol.handler = { request in
            let status = request.url!.path == "/message" ? 413 : 404
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        let conversation = ChatConversation(thread: .agent, client: client(),
            store: ChatHistoryStore(thread: "rejected-turn", directory: directory), nodeID: "mobile:test")
        conversation.draft = "Synthetic request"
        XCTAssertTrue(conversation.submitDraft())
        for _ in 0..<100 where conversation.isSending { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(conversation.isSending)
        XCTAssertTrue(conversation.messages.last?.text.contains("error 413") == true)
        XCTAssertFalse(conversation.messages.last?.text.contains("Connection lost") == true)
        XCTAssertFalse(conversation.messages.last?.retrySafe == true)
    }

    func testUnreadableImageGivesAnActionableError() async {
        do {
            _ = try await ChatAttachmentPreparation.prepare(Data("invalid image".utf8), name: "Invalid.jpg")
            XCTFail("Invalid images must not reach the composer")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Choose another")) }
    }

    func testOldMainModelFailureExplainsUpdateAndPreservesPairing() {
        XCTAssertTrue(ModelSettingsErrorCopy.message(for: DaemonError.notFound).contains("Update the main server"))
        XCTAssertTrue(ModelSettingsErrorCopy.message(for: DaemonError.notFound).contains("pairing is saved"))
        XCTAssertEqual(ModelSettingsErrorCopy.message(for: DaemonError.mainConnection(.authorizationRequired)), MainConnectionIssue.authorizationRequired.message)
    }

    func testBottomGeometryIncludesKeyboardAndSafeAreaInsets() {
        XCTAssertTrue(ChatScrollGeometry(contentHeight: 1200, viewportHeight: 500, offset: 740, bottomInset: 40).isAtBottom)
        XCTAssertFalse(ChatScrollGeometry(contentHeight: 1200, viewportHeight: 500, offset: 300, bottomInset: 40).isAtBottom)
        XCTAssertTrue(ChatScrollGeometry(contentHeight: 200, viewportHeight: 500, offset: 0, bottomInset: 40).isAtBottom)
    }

    func testShortHistoryHasNoHiddenContentDespiteBottomAlignmentOrOverscroll() {
        XCTAssertTrue(ChatScrollGeometry(contentHeight: 200, viewportHeight: 500, offset: -340, bottomInset: 40).isAtBottom)
        XCTAssertTrue(ChatScrollGeometry(contentHeight: 500, viewportHeight: 500, offset: -100, bottomInset: 0).isAtBottom)
        XCTAssertTrue(ChatScrollGeometry(contentHeight: 0, viewportHeight: 500, offset: -100, bottomInset: 40).isAtBottom)
    }

    func testExpandingTheViewportRemovesTheNeedToJump() {
        XCTAssertFalse(ChatScrollGeometry(contentHeight: 700, viewportHeight: 300, offset: -100, bottomInset: 40).isAtBottom)
        XCTAssertTrue(ChatScrollGeometry(contentHeight: 700, viewportHeight: 900, offset: -100, bottomInset: 40).isAtBottom)
    }
}
