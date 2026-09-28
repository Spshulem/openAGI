import XCTest
@testable import OpenAGI

// `ChatHistoryMerge`: folding a page of the daemon's shared thread into the
// phone's own list. The daemon wins inside its page; the phone keeps what
// the daemon can't know about yet; identity stays stable across merges.
final class ChatHistoryMergeTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_790_000_000)

    private func at(_ seconds: TimeInterval) -> Date { base.addingTimeInterval(seconds) }

    private func server(_ id: String, _ role: ConversationMessage.Role, _ text: String, _ seconds: TimeInterval,
                        source: String? = nil) -> ConversationMessage {
        ConversationMessage(id: id, role: role, text: text, at: at(seconds), sourceNodeId: source, sourceName: source.map { "\($0) name" })
    }

    func testEmptyServerPageKeepsTheLocalCache() {
        let local = [ChatMessage(role: .user, text: "hi", timestamp: at(0))]
        XCTAssertEqual(ChatHistoryMerge.merge(local: local, server: []), local)
    }

    func testFreshPhoneTakesTheServerThreadIncludingOtherDevicesLines() {
        let merged = ChatHistoryMerge.merge(local: [], server: [
            server("m1", .user, "From the glasses", 0, source: "g2:1"),
            server("m2", .assistant, "Reply", 5),
        ])
        XCTAssertEqual(merged.map(\.text), ["From the glasses", "Reply"])
        XCTAssertEqual(merged.map(\.serverID), ["m1", "m2"])
        XCTAssertEqual(merged[0].sourceName, "g2:1 name")
        XCTAssertEqual(ChatSourceLabel.text(for: merged[0], ownNodeID: "mobile:me"), "From g2:1 name")
        XCTAssertNil(ChatSourceLabel.text(for: merged[1], ownNodeID: "mobile:me"))
    }

    func testLocalLinesMatchTheirStoredCopyAndKeepTheirIdentity() {
        let question = ChatMessage(role: .user, text: "What's on today?", timestamp: at(0))
        let answer = ChatMessage(role: .assistant, text: "Two things.", timestamp: at(4))
        let merged = ChatHistoryMerge.merge(local: [question, answer], server: [
            server("m1", .user, "What's on today?", 1, source: "mobile:me"),
            server("m2", .assistant, "Two things.\n", 5),
        ])
        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged.map(\.id), [question.id, answer.id])
        XCTAssertEqual(merged.map(\.serverID), ["m1", "m2"])
        XCTAssertNil(ChatSourceLabel.text(for: merged[0], ownNodeID: "mobile:me"))

        // A second merge of the same page changes nothing.
        let again = ChatHistoryMerge.merge(local: merged, server: [
            server("m1", .user, "What's on today?", 1, source: "mobile:me"),
            server("m2", .assistant, "Two things.\n", 5),
        ])
        XCTAssertEqual(again, merged)
    }

    func testOtherDevicesTurnsInterleaveByTime() {
        let mine = ChatMessage(role: .user, text: "phone question", timestamp: at(0), serverID: "m1")
        let merged = ChatHistoryMerge.merge(local: [mine], server: [
            server("m1", .user, "phone question", 0),
            server("m2", .assistant, "phone answer", 2),
            server("m3", .user, "glasses question", 60, source: "g2:1"),
            server("m4", .assistant, "glasses answer", 62),
        ])
        XCTAssertEqual(merged.map(\.text), ["phone question", "phone answer", "glasses question", "glasses answer"])
        XCTAssertEqual(merged[0].id, mine.id)
    }

    func testAReplyStillStreamingStaysLastWithItsQuestion() {
        let question = ChatMessage(role: .user, text: "long task", timestamp: at(100))
        let streaming = ChatMessage(role: .assistant, text: "Work", isStreaming: true, timestamp: at(100))
        let merged = ChatHistoryMerge.merge(local: [question, streaming], server: [
            server("m1", .user, "older", 0),
            server("m2", .assistant, "older reply", 1),
            // Another device's turn landed while this reply streams.
            server("m3", .user, "glasses", 150, source: "g2:1"),
        ])
        XCTAssertEqual(merged.last?.id, streaming.id)
        XCTAssertTrue(merged.last?.isStreaming ?? false)
        XCTAssertTrue(merged.contains(where: { $0.id == question.id }))
    }

    func testAStoredQuestionReplacesTheLocalCopyWhileItsReplyStreams() {
        let question = ChatMessage(role: .user, text: "long task", timestamp: at(100))
        let streaming = ChatMessage(role: .assistant, text: "", isStreaming: true, timestamp: at(100))
        let merged = ChatHistoryMerge.merge(local: [question, streaming], server: [
            server("m1", .user, "long task", 101),
        ])
        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged[0].id, question.id)
        XCTAssertEqual(merged[0].serverID, "m1")
        XCTAssertEqual(merged[1].id, streaming.id)
    }

    func testAStoppedReplyClearsWhenMainFinishedAndStoredIt() {
        let question = ChatMessage(role: .user, text: "summarize", timestamp: at(0))
        let stopped = ChatMessage(role: .assistant, text: ChatHistoryCodec.stoppedText, isFailed: true, timestamp: at(0))
        let merged = ChatHistoryMerge.merge(local: [question, stopped], server: [
            server("m1", .user, "summarize", 1),
            server("m2", .assistant, "Here's the summary.", 30),
        ])
        XCTAssertEqual(merged.map(\.text), ["summarize", "Here's the summary."])
        XCTAssertFalse(merged.contains(where: \.isFailed))
    }

    func testAFailedReplyMainNeverAnsweredKeepsTryAgainAfterItsQuestion() {
        let question = ChatMessage(role: .user, text: "summarize", timestamp: at(0))
        let failed = ChatMessage(role: .assistant, text: "Can't reach OpenAGI.", isFailed: true, timestamp: at(-30))
        let merged = ChatHistoryMerge.merge(local: [question, failed], server: [
            server("m0", .assistant, "earlier", -60),
            server("m1", .user, "summarize", 1),
        ])
        XCTAssertEqual(merged.map(\.text), ["earlier", "summarize", "Can't reach OpenAGI."])
        XCTAssertTrue(merged.last?.isFailed ?? false)
        XCTAssertEqual(ChatRetry.target(failedID: failed.id, in: merged, isSending: false)?.userText, "summarize")
    }

    // A refresh that lands mid-stream ties the question to its server id;
    // when the stream then fails, the final merge must still anchor the
    // failed reply after that question, not by its own earlier clock --
    // otherwise it sorts above the question and Try again resends the
    // previous prompt.
    func testAFailedReplyStaysAfterAQuestionStoredMidStream() throws {
        let question = ChatMessage(role: .user, text: "summarize", timestamp: at(100))
        let streaming = ChatMessage(role: .assistant, text: "", isStreaming: true, timestamp: at(100))
        let page = [
            server("m0", .user, "earlier", 0),
            server("m1", .assistant, "earlier reply", 1),
            server("m2", .user, "summarize", 101),
        ]
        var messages = ChatHistoryMerge.merge(local: [question, streaming], server: page)
        XCTAssertEqual(messages.first(where: { $0.id == question.id })?.serverID, "m2")

        let index = try XCTUnwrap(messages.firstIndex(where: { $0.id == streaming.id }))
        messages[index].text = "Reply stopped early. Try again."
        messages[index].isStreaming = false
        messages[index].isFailed = true

        let merged = ChatHistoryMerge.merge(local: messages, server: page)
        XCTAssertEqual(merged.map(\.text), ["earlier", "earlier reply", "summarize", "Reply stopped early. Try again."])
        XCTAssertEqual(ChatRetry.target(failedID: streaming.id, in: merged, isSending: false)?.userText, "summarize")
    }

    func testAFailedSendMainNeverSawKeepsBothLines() {
        let question = ChatMessage(role: .user, text: "offline ask", timestamp: at(10))
        let failed = ChatMessage(role: .assistant, text: "Can't reach OpenAGI.", isFailed: true, timestamp: at(10))
        let merged = ChatHistoryMerge.merge(local: [question, failed], server: [
            server("m1", .user, "a", 0),
            server("m2", .assistant, "b", 20),
        ])
        XCTAssertEqual(merged.map(\.text), ["a", "offline ask", "Can't reach OpenAGI.", "b"])
    }

    func testAFinishedLocalReplyNotStoredYetStaysUntilMainCatchesUp() {
        let question = ChatMessage(role: .user, text: "new", timestamp: at(100))
        let answer = ChatMessage(role: .assistant, text: "answer", timestamp: at(102))
        let merged = ChatHistoryMerge.merge(local: [question, answer], server: [
            server("m1", .user, "old", 0),
            server("m2", .assistant, "old answer", 1),
        ])
        XCTAssertEqual(merged.map(\.text), ["old", "old answer", "new", "answer"])
    }

    func testMainIsAuthoritativeInsideItsWindow() {
        // A local-only line older than main's newest line that main never
        // stored (another phone's stale cache, a pre-thread session) goes;
        // a line tied to a server id main no longer returns goes too.
        let stale = ChatMessage(role: .assistant, text: "stale", timestamp: at(5))
        let deleted = ChatMessage(role: .user, text: "deleted", timestamp: at(6), serverID: "gone")
        let merged = ChatHistoryMerge.merge(local: [stale, deleted], server: [
            server("m1", .user, "a", 0),
            server("m2", .assistant, "b", 10),
        ])
        XCTAssertEqual(merged.map(\.text), ["a", "b"])
    }

    func testHistoryOlderThanThePageIsKept() {
        let old = ChatMessage(role: .user, text: "last week", timestamp: at(-86_400), serverID: "m0")
        let oldReply = ChatMessage(role: .assistant, text: "last week reply", timestamp: at(-86_390), serverID: "m0b")
        let merged = ChatHistoryMerge.merge(local: [old, oldReply], server: [
            server("m1", .user, "today", 0),
        ])
        XCTAssertEqual(merged.map(\.text), ["last week", "last week reply", "today"])
        XCTAssertEqual(merged[0].id, old.id)
    }

    func testRepeatedIdenticalQuestionsMatchOneToOne() {
        let first = ChatMessage(role: .user, text: "status?", timestamp: at(0))
        let second = ChatMessage(role: .user, text: "status?", timestamp: at(60))
        let merged = ChatHistoryMerge.merge(local: [first, second], server: [
            server("m1", .user, "status?", 1),
            server("m2", .assistant, "ok", 2),
            server("m3", .user, "status?", 61),
        ])
        XCTAssertEqual(merged.map(\.serverID), ["m1", "m2", "m3"])
        XCTAssertEqual(merged[0].id, first.id)
        XCTAssertEqual(merged[2].id, second.id)
    }
}
