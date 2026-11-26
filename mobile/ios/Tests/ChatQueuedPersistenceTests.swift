import XCTest
import SupervisorChannelsKit
@testable import OpenAGI

// Queued messages main has not taken yet survive a force-quit: typed while
// main was out of reach, they come back on relaunch with the same turn id
// and reach the hub once. Messages the hub already has are not kept on the
// phone (the hub's queue is durable). Synthetic data only.
final class ChatQueuedPersistenceTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "chat-queued-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        FakeHubProtocol.reset()
    }

    override func tearDownWithError() throws {
        FakeHubProtocol.reset()
        try? FileManager.default.removeItem(at: directory)
    }

    func testQueuedMessagesRoundTripPerPairingAndLeaveNoFileWhenEmpty() {
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        let image = ChatAttachment(id: "img-1", name: "shot.jpg", data: "AAAA", thumbnail: "BB")
        let items = [
            SavedQueuedMessage(requestID: "ios-queued-0001", text: "first", attachments: [image], focusedCardID: "card:1",
                               pendingUpload: false, uploadAttempted: false),
            SavedQueuedMessage(requestID: "ios-queued-0002", text: "second", attachments: [], focusedCardID: nil,
                               pendingUpload: true, uploadAttempted: true, error: nil),
        ]
        store.saveQueued(nodeID: "mobile:a", items: items)
        XCTAssertEqual(store.loadQueued(nodeID: "mobile:a"), items)
        XCTAssertEqual(store.loadQueued(nodeID: "mobile:b"), [], "another pairing reads nothing")
        XCTAssertEqual(store.loadQueued(nodeID: "mobile:a").first?.attachments.first?.data, "AAAA", "the full image is kept")

        store.saveQueued(nodeID: "mobile:a", items: [])
        XCTAssertEqual(store.loadQueued(nodeID: "mobile:a"), [])
        store.saveQueued(nodeID: "mobile:a", items: items)
        store.delete()
        XCTAssertEqual(store.loadQueued(nodeID: "mobile:a"), [], "forgetting the pairing removes them too")
    }

    func testOnlyMessagesMainHasNotTakenAreKeptAndTheyComeBackInOrder() {
        var queue = QueuedTurnQueue<ChatQueuedPayload>()
        queue.enqueue(text: "local only", payload: ChatQueuedPayload(attachments: [], focusedCardID: "card:2"), requestID: "ios-local-00001")
        queue.enqueue(text: "on the hub", payload: ChatQueuedPayload(attachments: [], focusedCardID: nil), requestID: "ios-onhub-00002",
                      origin: QueuedOrigin(mine: true, revision: 1, pendingUpload: false))
        queue.enqueue(text: "upload unanswered", payload: ChatQueuedPayload(attachments: [], focusedCardID: nil), requestID: "ios-unsure-0003",
                      origin: QueuedOrigin(mine: true, pendingUpload: true, uploadAttempted: true))
        let pending = ChatConversation.pendingQueue(queue)
        XCTAssertEqual(pending.map(\.requestID), ["ios-local-00001", "ios-unsure-0003"], "the hub's own item is not kept here")

        let restored = ChatConversation.restoredQueue(pending)
        XCTAssertEqual(restored.items.map(\.text), ["local only", "upload unanswered"])
        XCTAssertEqual(restored.items.map(\.requestID), ["ios-local-00001", "ios-unsure-0003"])
        XCTAssertNil(restored.items[0].origin)
        XCTAssertEqual(restored.items[0].payload.focusedCardID, "card:2")
        XCTAssertEqual(restored.items[1].origin?.pendingUpload, true)
        XCTAssertEqual(restored.items[1].origin?.uploadAttempted, true, "still possibly on the hub")
    }

    @MainActor
    private func chat(store: ChatHistoryStore) -> ChatConversation {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeHubProtocol.self]
        let client = DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:test", token: "synthetic-token",
                                  session: URLSession(configuration: config))
        return ChatConversation(thread: .supervisor, client: client, store: store, nodeID: "mobile:test")
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
    func testAMessageQueuedOfflineSurvivesARelaunchAndReachesTheHubOnce() async throws {
        FakeHubProtocol.set { $0 = [.init(requestId: "mac-running-7", text: "Mac's turn", source: "Mac", mine: false, state: "running", revision: 1)] }
        let store = ChatHistoryStore(thread: "queued-\(UUID().uuidString)", directory: directory)
        var requestID = ""
        do {
            let before = chat(store: store)
            await before.refresh()
            XCTAssertTrue(before.hubQueueAvailable)
            FakeHubProtocol.lock.withLock { FakeHubProtocol.offlineEnqueue = true }
            before.draft = "typed while main was out of reach"
            XCTAssertTrue(before.submitDraft())
            try await waitFor("the failed upload") { FakeHubProtocol.calls().contains { $0.hasPrefix("POST /conversations/supervisor/queue") } }
            try await Task.sleep(for: .milliseconds(50))
            requestID = try XCTUnwrap(before.queuedSubmissions.first?.requestID)
            XCTAssertEqual(store.loadQueued(nodeID: "mobile:test").map(\.requestID), [requestID], "on disk before the app can be killed")
        }

        // The app is killed and opened again; main is reachable now.
        let after = chat(store: store)
        XCTAssertEqual(after.queuedSubmissions.map(\.text), ["typed while main was out of reach"])
        XCTAssertEqual(after.queuedSubmissions.first?.requestID, requestID, "the same turn id, so main runs it once")
        FakeHubProtocol.lock.withLock { FakeHubProtocol.offlineEnqueue = false }
        await after.refresh()
        try await waitFor("the hub to take it") { FakeHubProtocol.snapshot().contains { $0.requestId == requestID } }
        try await waitFor("nothing left only on this phone") { store.loadQueued(nodeID: "mobile:test").isEmpty }
        XCTAssertEqual(FakeHubProtocol.snapshot().filter { $0.requestId == requestID }.count, 1)
        XCTAssertEqual(after.queuedSubmissions.map(\.requestID), [requestID], "shown as the hub's waiting message")
        XCTAssertEqual(after.queuedSubmissions.first?.origin?.pendingUpload, false)
    }
}
