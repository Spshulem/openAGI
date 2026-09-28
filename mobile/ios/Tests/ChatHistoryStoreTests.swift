import XCTest
@testable import OpenAGI

// The per-pairing chat cache: what survives a relaunch, what a different
// pairing must never see, and what a reply cut off by the app closing turns
// into on disk.
final class ChatHistoryStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "chat-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testRoundTripsEveryField() {
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        let entry = SavedChatEntry(id: UUID(), serverID: "m1", role: "user", at: Date(timeIntervalSince1970: 1_790_000_000),
                                   text: "hi", failed: false, sourceNodeId: "g2:1", sourceName: "Spencer's G2")
        store.save(nodeID: "mobile:a", entries: [entry])
        XCTAssertEqual(store.load(nodeID: "mobile:a"), [entry])
    }

    func testAnotherPairingReadsNothing() {
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        store.save(nodeID: "mobile:a", entries: [SavedChatEntry(id: UUID(), role: "user", at: Date(), text: "secret")])
        XCTAssertEqual(store.load(nodeID: "mobile:b"), [])
    }

    func testThreadsAreSeparateFiles() {
        ChatHistoryStore(thread: "agent", directory: directory)
            .save(nodeID: "n", entries: [SavedChatEntry(id: UUID(), role: "user", at: Date(), text: "agent line")])
        XCTAssertEqual(ChatHistoryStore(thread: "supervisor", directory: directory).load(nodeID: "n"), [])
        XCTAssertEqual(ChatHistoryStore(thread: "agent", directory: directory).load(nodeID: "n").map(\.text), ["agent line"])
    }

    func testKeepsOnlyTheNewestEntries() {
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        let entries = (0..<(ChatHistoryStore.maxEntries + 25)).map {
            SavedChatEntry(id: UUID(), role: "user", at: Date(timeIntervalSince1970: TimeInterval($0)), text: "\($0)")
        }
        store.save(nodeID: "n", entries: entries)
        let loaded = store.load(nodeID: "n")
        XCTAssertEqual(loaded.count, ChatHistoryStore.maxEntries)
        XCTAssertEqual(loaded.first?.text, "25")
        XCTAssertEqual(loaded.last?.text, "\(ChatHistoryStore.maxEntries + 24)")
    }

    func testTornFileReadsAsEmptyAndDeleteRemovesIt() throws {
        let store = ChatHistoryStore(thread: "agent", directory: directory)
        try Data("{not json".utf8).write(to: directory.appending(path: "chat-agent.json"))
        XCTAssertEqual(store.load(nodeID: "n"), [])
        store.save(nodeID: "n", entries: [SavedChatEntry(id: UUID(), role: "user", at: Date(), text: "x")])
        store.delete()
        XCTAssertEqual(store.load(nodeID: "n"), [])
    }

    func testAReplyStillStreamingIsSavedAsStopped() {
        let streaming = ChatMessage(role: .assistant, text: "Half a rep", isStreaming: true)
        let saved = ChatHistoryCodec.saved(streaming)
        XCTAssertTrue(saved.failed)
        XCTAssertEqual(saved.text, "Reply stopped when the app closed.")

        let restored = ChatHistoryCodec.message(saved)
        XCTAssertEqual(restored.id, streaming.id)
        XCTAssertTrue(restored.isFailed)
        XCTAssertFalse(restored.isStreaming)
    }

    func testAFailedReplyKeepsItsOwnText() {
        let failed = ChatMessage(role: .assistant, text: "Can't reach OpenAGI.", isFailed: true)
        XCTAssertEqual(ChatHistoryCodec.saved(failed).text, "Can't reach OpenAGI.")
    }
}
