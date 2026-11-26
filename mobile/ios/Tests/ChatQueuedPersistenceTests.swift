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
        // No hub queue: every item is this phone's own, including one an
        // edit gave an origin.
        var local = QueuedTurnQueue<ChatQueuedPayload>()
        local.enqueue(text: "local only", payload: ChatQueuedPayload(attachments: [], focusedCardID: "card:2"), requestID: "ios-local-00001")
        let edited = local.enqueue(text: "edited here", payload: ChatQueuedPayload(attachments: [], focusedCardID: nil), requestID: "ios-edited-0002")
        local.setOrigin(edited) { $0.error = nil }
        let kept = ChatConversation.pendingQueue(local, hubQueueAvailable: false)
        XCTAssertEqual(kept.map(\.requestID), ["ios-local-00001", "ios-edited-0002"])

        // A hub queue: only what it has not accepted yet.
        var hub = QueuedTurnQueue<ChatQueuedPayload>()
        hub.enqueue(text: "on the hub", payload: ChatQueuedPayload(attachments: [], focusedCardID: nil), requestID: "ios-onhub-00003",
                    origin: QueuedOrigin(mine: true, revision: 1, pendingUpload: false))
        hub.enqueue(text: "send anyway, unanswered", payload: ChatQueuedPayload(attachments: [], focusedCardID: nil), requestID: "ios-unsure-0004",
                    origin: QueuedOrigin(mine: true, pendingUpload: true, sendNext: true, uploadAttempted: true))
        let onHub = ChatConversation.pendingQueue(hub, hubQueueAvailable: true)
        XCTAssertEqual(onHub.map(\.requestID), ["ios-unsure-0004"], "the hub's own item is not kept here")

        let restored = ChatConversation.restoredQueue(kept + onHub)
        XCTAssertEqual(restored.items.map(\.text), ["local only", "edited here", "send anyway, unanswered"])
        XCTAssertEqual(restored.items.map(\.requestID), ["ios-local-00001", "ios-edited-0002", "ios-unsure-0004"])
        XCTAssertNil(restored.items[0].origin)
        XCTAssertEqual(restored.items[0].payload.focusedCardID, "card:2")
        XCTAssertEqual(restored.items[2].origin?.pendingUpload, true)
        XCTAssertEqual(restored.items[2].origin?.uploadAttempted, true, "still possibly on the hub")
        XCTAssertEqual(restored.items[2].origin?.sendNext, true, "still goes next when the hub takes it")
    }

    @MainActor
    func testASentTurnMainNeverConfirmedComesBackWithItsFullImages() {
        // What a kill mid-send leaves: the history keeps the user line with a
        // preview only and the unconfirmed reply; the queued file keeps the
        // full images for that line.
        let store = ChatHistoryStore(thread: "sending-\(UUID().uuidString)", directory: directory)
        let userID = UUID()
        let full = ChatAttachment(id: "img-9", name: "shot.jpg", data: "FULLDATA", thumbnail: "TH")
        store.save(nodeID: "mobile:test", entries: [
            SavedChatEntry(id: userID, role: "user", at: Date(), text: "look at this", attachments: [full.previewOnly], requestID: "ios-sending-0001"),
            SavedChatEntry(id: UUID(), role: "assistant", at: Date(), text: ChatHistoryCodec.unconfirmedText, failed: true, retrySafe: true,
                           requestID: "ios-sending-0001", autoRetry: true),
        ])
        store.saveQueued(nodeID: "mobile:test", items: [], sending: [SavedSendingImages(userID: userID, attachments: [full])])
        XCTAssertEqual(store.loadSending(nodeID: "mobile:test").map(\.userID), [userID])

        let chat = chat(store: store)
        let user = chat.messages.first { $0.id == userID }
        XCTAssertEqual(user?.attachments.map(\.data), ["FULLDATA"], "the full image, not the preview")
        let reply = chat.messages.last
        XCTAssertEqual(reply?.retrySafe, true, "still resendable without reattaching")
        XCTAssertEqual(reply?.autoRetry, true)
    }

    func testRehydrationOnlyTouchesTheMatchingUserLine() {
        let target = UUID(), other = UUID()
        let entries = [
            SavedChatEntry(id: other, role: "user", at: Date(), text: "older", attachments: [ChatAttachment(id: "a", name: "a.jpg", data: nil, thumbnail: "x")]),
            SavedChatEntry(id: target, role: "user", at: Date(), text: "this one", attachments: [ChatAttachment(id: "b", name: "b.jpg", data: nil, thumbnail: "y")]),
        ]
        let out = ChatConversation.rehydrated(entries, sending: [SavedSendingImages(userID: target, attachments: [ChatAttachment(id: "b", name: "b.jpg", data: "DATA", thumbnail: "y")])])
        XCTAssertNil(out[0].attachments?.first?.data)
        XCTAssertEqual(out[1].attachments?.first?.data, "DATA")
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
