import XCTest
@testable import SupervisorChannelsKit

final class QueuedTurnQueueTests: XCTestCase {
    private func queue(_ texts: [String]) -> QueuedTurnQueue<Int> {
        var queue = QueuedTurnQueue<Int>()
        for (index, text) in texts.enumerated() { queue.enqueue(text: text, payload: index, requestID: "turn-\(text)") }
        return queue
    }

    func testDrainsInOrderAndRemoveKeepsTheRest() {
        var q = queue(["a", "b", "c", "d"])
        XCTAssertNotNil(q.remove(q.items[2].id))
        XCTAssertEqual(q.items.map(\.text), ["a", "b", "d"])
        XCTAssertEqual(q.takeNext()?.text, "a")
        XCTAssertEqual(q.takeNext()?.text, "b")
        XCTAssertEqual(q.takeNext()?.text, "d")
        XCTAssertNil(q.takeNext())
    }

    func testEditingHoldsTheQueueAtThatItemAndSavingNeverSends() {
        var q = queue(["first", "second"])
        let id = q.items[0].id
        XCTAssertEqual(q.beginEditing(id), "first")
        XCTAssertNil(q.takeNext(), "the old text must not send while its editor is open")
        XCTAssertTrue(q.isWaitingOnEdit)
        XCTAssertFalse(q.saveEdit(id, text: "   "), "a blank edit is refused, not sent or silently dropped")
        XCTAssertEqual(q.editingID, id)
        XCTAssertTrue(q.saveEdit(id, text: "  first, corrected \n"))
        XCTAssertNil(q.editingID)
        XCTAssertEqual(q.items.map(\.text), ["first, corrected", "second"], "the edit keeps its place")
        XCTAssertEqual(q.items[0].requestID, "turn-first", "and its turn id")
        XCTAssertEqual(q.takeNext()?.text, "first, corrected")
    }

    func testEditingALaterItemLetsEarlierOnesSendButNotPassIt() {
        var q = queue(["a", "b", "c"])
        _ = q.beginEditing(q.items[1].id)
        XCTAssertEqual(q.takeNext()?.text, "a")
        XCTAssertNil(q.takeNext(), "c must not jump ahead of the item being edited")
        q.cancelEdit()
        XCTAssertEqual(q.takeNext()?.text, "b")
        XCTAssertEqual(q.takeNext()?.text, "c")
    }

    func testOnlyOneEditAtATimeAndRemoveClosesIt() {
        var q = queue(["a", "b"])
        XCTAssertNotNil(q.beginEditing(q.items[0].id))
        XCTAssertNil(q.beginEditing(q.items[1].id))
        _ = q.remove(q.items[0].id)
        XCTAssertNil(q.editingID)
        XCTAssertEqual(q.takeNext()?.text, "b")
    }

    func testSendNowMovesToTheFrontKeepingOthersInOrder() {
        var q = queue(["a", "b", "c", "d"])
        let c = q.items[2].id
        XCTAssertEqual(q.beginSendNow(c, replyRunning: true, runningRequestID: "turn-running"), .interrupt(requestID: "turn-running"))
        XCTAssertEqual(q.items.map(\.text), ["c", "a", "b", "d"])
        XCTAssertEqual(q.items[0].sendNow, .requesting)
    }

    func testDoubleTapAndASecondItemWaitWhileTheFirstIsPendingOrSettled() {
        var q = queue(["a", "b"])
        let b = q.items[1].id, a = q.items[0].id
        XCTAssertEqual(q.beginSendNow(b, replyRunning: true, runningRequestID: "turn-r"), .interrupt(requestID: "turn-r"))
        XCTAssertEqual(q.beginSendNow(b, replyRunning: true, runningRequestID: "turn-r"), .ignored, "double tap")
        XCTAssertEqual(q.beginSendNow(a, replyRunning: true, runningRequestID: "turn-r"), .ignored)
        q.applyInterrupt(b, outcome: .stopping(tool: "send_email"))
        XCTAssertEqual(q.beginSendNow(a, replyRunning: true, runningRequestID: "turn-r"), .ignored, "b already goes next")
        XCTAssertEqual(q.items.map(\.text), ["b", "a"])
    }

    func testAnUnsettledInterruptCanBeRetriedOrRetargeted() {
        for failure in [TurnInterruptOutcome.unreachable, .unsupported, .notFound] {
            var q = queue(["a", "b"])
            let a = q.items[0].id, b = q.items[1].id
            _ = q.beginSendNow(b, replyRunning: true, runningRequestID: "turn-r")
            q.applyInterrupt(b, outcome: failure)
            XCTAssertTrue(q.items[0].sendNow?.isError == true)
            XCTAssertTrue(q.canSendNow(b), "retry after \(failure)")
            XCTAssertEqual(q.beginSendNow(a, replyRunning: true, runningRequestID: "turn-r"), .interrupt(requestID: "turn-r"))
            XCTAssertEqual(q.items.map(\.text), ["a", "b"])
            XCTAssertNil(q.items[1].sendNow, "the earlier item no longer claims the next slot")
        }
    }

    func testNothingRunningMeansItSimplyGoesNext() {
        var q = queue(["a", "b"])
        XCTAssertEqual(q.beginSendNow(q.items[1].id, replyRunning: false, runningRequestID: nil), .sendNext)
        XCTAssertEqual(q.items.map(\.text), ["b", "a"])
        XCTAssertNil(q.items[0].sendNow)
    }

    func testAReplyMainCannotNameIsReportedAsNotInterruptible() {
        var q = queue(["a", "b"])
        XCTAssertEqual(q.beginSendNow(q.items[1].id, replyRunning: true, runningRequestID: nil), .cannotInterrupt)
        XCTAssertEqual(q.items.map(\.text), ["b", "a"])
        XCTAssertEqual(q.items[0].sendNow, .answered(.unsupported))
        XCTAssertTrue(q.items[0].sendNow?.label.contains("can't interrupt") == true)
    }

    func testTheItemBeingEditedCannotBeSentNow() {
        var q = queue(["a"])
        _ = q.beginEditing(q.items[0].id)
        XCTAssertEqual(q.beginSendNow(q.items[0].id, replyRunning: true, runningRequestID: "turn-r"), .ignored)
    }

    func testAnAnswerForAnItemAlreadySentOrRemovedIsIgnored() {
        var q = queue(["a", "b"])
        let b = q.items[1].id
        _ = q.beginSendNow(b, replyRunning: true, runningRequestID: "turn-r")
        XCTAssertEqual(q.takeNext()?.id, b, "the reply ended before main answered: b went")
        q.applyInterrupt(b, outcome: .interrupted)
        XCTAssertEqual(q.items.map(\.text), ["a"])
        XCTAssertNil(q.items[0].sendNow)
    }

    func testCopyNeverClaimsAnUnconfirmedStop() {
        XCTAssertEqual(TurnInterruptOutcome.fromServer(status: "interrupted", tool: nil), .interrupted)
        XCTAssertEqual(TurnInterruptOutcome.fromServer(status: "stopping", tool: "send_email"), .stopping(tool: "send_email"))
        XCTAssertEqual(TurnInterruptOutcome.fromServer(status: "finished", tool: nil), .finished)
        XCTAssertEqual(TurnInterruptOutcome.fromServer(status: "not_found", tool: nil), .notFound)
        XCTAssertEqual(TurnInterruptOutcome.fromServer(status: "weird", tool: nil), .unreachable)
        XCTAssertTrue(QueuedSendNowState.answered(.stopping(tool: "send_email")).label.contains("won't be undone"))
        XCTAssertTrue(QueuedSendNowState.answered(.stopping(tool: "send_email")).label.contains("send email"))
        for outcome in [TurnInterruptOutcome.finished, .notFound, .unsupported, .unreachable] {
            XCTAssertFalse(QueuedSendNowState.answered(outcome).label.hasPrefix("Reply stopped"), "\(outcome)")
        }
    }
}
