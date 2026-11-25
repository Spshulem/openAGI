import XCTest
@testable import OpenAGI

// mobile/PROTOCOL.md §3.1 "Recovering a turn": a reply whose stream iOS cut
// (backgrounded, locked, network drop) is found again in history by its turn
// id, never resent; a send main never confirmed is offered again (same id).
final class ChatTurnRecoveryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    private func detached(_ id: String, at offset: TimeInterval = -10) -> [ChatMessage] {
        var user = ChatMessage(role: .user, text: "plan my day", timestamp: now.addingTimeInterval(offset))
        user.requestID = id
        var reply = ChatMessage(role: .assistant, text: "", isStreaming: true, timestamp: now.addingTimeInterval(offset))
        reply.requestID = id
        reply.accepted = true
        reply.isDetached = true
        return [user, reply]
    }

    private func page(_ messages: [ConversationMessage], inFlight: [String]? = []) -> ConversationPage {
        ConversationPage(thread: "agent", messages: messages, nextBefore: nil,
                         inFlight: inFlight.map { $0.map { InFlightTurn(requestId: $0, stage: "model") } })
    }

    private func line(_ id: String, _ role: ConversationMessage.Role, _ text: String, turn: String?, status: String? = nil) -> ConversationMessage {
        ConversationMessage(id: id, role: role, text: text, at: now, requestId: turn, status: status)
    }

    func testAStillRunningTurnKeepsWorking() {
        let local = detached("ios-1")
        let result = ChatTurnRecovery.resolve(local, page: page([line("m1", .user, "plan my day", turn: "ios-1")], inFlight: ["ios-1"]), now: now)
        XCTAssertEqual(result, local)
    }

    func testTheStoredReplyReplacesTheWorkingLine() {
        let merged = detached("ios-1")
        let server = page([line("m1", .user, "plan my day", turn: "ios-1"), line("m2", .assistant, "Here's your day.", turn: "ios-1")])
        let result = ChatTurnRecovery.resolve(merged, page: server, now: now)
        XCTAssertEqual(result.map(\.role), [.user], "the placeholder goes; the merge already holds main's reply")
    }

    func testATurnMainLostOffersARetryAsANewTurn() {
        let server = page([line("m1", .user, "plan my day", turn: "ios-1")])
        let result = ChatTurnRecovery.resolve(detached("ios-1"), page: server, now: now)
        let reply = try! XCTUnwrap(result.last)
        XCTAssertTrue(reply.isFailed && reply.retrySafe && reply.newRequestOnRetry)
        XCTAssertFalse(reply.isStreaming || reply.isDetached)
        XCTAssertEqual(reply.text, ChatTurnRecovery.interruptedText)
    }

    func testAnOlderMainThatCannotListRunningTurnsIsWaitedOnUntilStale() {
        let server = page([line("m1", .user, "plan my day", turn: nil)], inFlight: nil)
        let waiting = detached("ios-1")
        XCTAssertEqual(ChatTurnRecovery.resolve(waiting, page: server, now: now), waiting)
        let stale = ChatTurnRecovery.resolve(detached("ios-1", at: -(ChatTurnRecovery.staleAfter + 1)), page: server, now: now)
        XCTAssertTrue(try XCTUnwrap(stale.last).isFailed)
        XCTAssertFalse(try XCTUnwrap(stale.last).newRequestOnRetry, "a stale turn may still be running: retry follows it")
    }

    func testAcceptedRepliesSurviveARelaunchAsRecoveringNotStopped() {
        var reply = ChatMessage(role: .assistant, text: "partial", isStreaming: true)
        reply.requestID = "ios-2"
        reply.accepted = true
        let saved = ChatHistoryCodec.saved(reply)
        XCTAssertEqual(saved.detached, true)
        XCTAssertFalse(saved.failed)
        let restored = ChatHistoryCodec.message(saved)
        XCTAssertTrue(restored.isStreaming && restored.isDetached && restored.accepted)
        XCTAssertEqual(restored.requestID, "ios-2")
        XCTAssertEqual(restored.activity, ChatHistoryCodec.stillWorking)
    }

    func testAnUnconfirmedSendSurvivesARelaunchAsRetrySafeAndRetriedOnce() {
        var reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        reply.requestID = "ios-3"
        let restored = ChatHistoryCodec.message(ChatHistoryCodec.saved(reply))
        XCTAssertTrue(restored.isFailed && restored.retrySafe && restored.autoRetry)
        XCTAssertEqual(restored.requestID, "ios-3")
        XCTAssertEqual(restored.text, ChatHistoryCodec.unconfirmedText)
    }

    func testARepliesWithoutATurnIdStillStopWhenTheAppCloses() {
        let reply = ChatMessage(role: .assistant, text: "partial", isStreaming: true)
        let restored = ChatHistoryCodec.message(ChatHistoryCodec.saved(reply))
        XCTAssertEqual(restored.text, ChatHistoryCodec.stoppedText)
        XCTAssertFalse(restored.retrySafe)
    }

    func testHistoryDecodesTurnIdsFailuresAndRunningTurns() throws {
        let json = #"""
        {"thread":"agent","nextBefore":null,
         "messages":[{"id":"m1","role":"user","text":"hi","at":"2026-11-20T10:00:00.000Z","requestId":"ios-4"},
                     {"id":"m2","role":"assistant","text":"I couldn't…","at":"2026-11-20T10:00:01.000Z","requestId":"ios-4","status":"failed"}],
         "inFlight":[{"requestId":"ios-5","stage":"model","startedAt":"2026-11-20T10:00:02.000Z"}]}
        """#
        let decoded = try ProtocolDecoder.json.decode(ConversationPage.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.messages.map(\.requestId), ["ios-4", "ios-4"])
        XCTAssertEqual(decoded.messages.last?.status, "failed")
        XCTAssertEqual(decoded.inFlight?.map(\.requestId), ["ios-5"])
        let older = try ProtocolDecoder.json.decode(ConversationPage.self, from: Data(#"{"messages":[],"nextBefore":null}"#.utf8))
        XCTAssertNil(older.inFlight, "an older main cannot say what is running")
    }

    func testMergeTiesALocalLineToMainsCopyByTurnId() {
        var user = ChatMessage(role: .user, text: "plan my day ", timestamp: now)
        user.requestID = "ios-6"
        let merged = ChatHistoryMerge.merge(local: [user], server: [line("m1", .user, "Plan my day, please", turn: "ios-6")])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged.first?.id, user.id, "the same line, not a duplicate")
        XCTAssertEqual(merged.first?.serverID, "m1")
    }
}
