import XCTest
@testable import OpenAGI

// "Try again" must share `send()`'s single-flight gate: a retry while a send
// or another retry is in flight would post a second concurrent `/message`.
final class ChatRetryTests: XCTestCase {
    private func conversation() -> (messages: [ChatMessage], failedID: UUID) {
        var failed = ChatMessage(role: .assistant, text: "Can't reach OpenAGI.")
        failed.isFailed = true
        return ([ChatMessage(role: .user, text: "first"),
                 ChatMessage(role: .assistant, text: "ok"),
                 ChatMessage(role: .user, text: "second"),
                 failed], failed.id)
    }

    func testRetryResendsThePrecedingUserMessageWhenIdle() throws {
        let (messages, failedID) = conversation()
        let target = try XCTUnwrap(ChatRetry.target(failedID: failedID, in: messages, isSending: false))
        XCTAssertEqual(target.index, 3)
        XCTAssertEqual(target.userText, "second")
    }

    func testRetryIsRefusedWhileASendIsInFlight() {
        let (messages, failedID) = conversation()
        XCTAssertNil(ChatRetry.target(failedID: failedID, in: messages, isSending: true))
    }

    func testRetryOfAnAlreadyReplacedBubbleDoesNothing() {
        let (messages, _) = conversation()
        XCTAssertNil(ChatRetry.target(failedID: UUID(), in: messages, isSending: false))
    }

    func testInterruptedTurnCannotBeBlindlyResent() {
        var (messages, failedID) = conversation()
        messages[3].retrySafe = false
        XCTAssertNil(ChatRetry.target(failedID: failedID, in: messages, isSending: false))
    }
}
