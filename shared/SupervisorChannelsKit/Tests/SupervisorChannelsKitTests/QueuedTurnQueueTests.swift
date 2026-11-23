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

final class HubQueueMirrorTests: XCTestCase {
    private func hub(_ items: [(String, String, String, Bool)], revision: Int = 1) -> HubQueueSnapshot {
        HubQueueSnapshot(revision: revision, items: items.enumerated().map { index, entry in
            HubQueueItem(requestId: entry.0, text: entry.1, source: .init(device: entry.3 ? "phone" : "owner", name: entry.3 ? "iPhone" : "Mac", nodeId: nil),
                         mine: entry.3, state: entry.2, heldBy: entry.2 == "held" ? "Mac" : nil, position: index, revision: 1)
        })
    }

    func testMirrorShowsEveryDevicesWaitingMessagesInTheHubsOrder() {
        var q = QueuedTurnQueue<Int>()
        q.mirror(hub([("r", "running", "running", false), ("a", "from mac", "queued", false), ("b", "from phone", "held", true)]), payload: { _ in 0 })
        XCTAssertEqual(q.items.map(\.text), ["from mac", "from phone"], "the running one is not waiting")
        XCTAssertEqual(q.items.map { $0.origin?.sourceName }, ["Mac", "iPhone"])
        XCTAssertEqual(q.items.map { $0.origin?.mine }, [false, true])
        XCTAssertEqual(q.items[1].origin?.heldBy, "Mac")
    }

    func testMirrorKeepsLocalStateAndMessagesTheHubHasNotAcceptedYet() {
        var q = QueuedTurnQueue<Int>()
        q.mirror(hub([("a", "one", "queued", true), ("b", "two", "queued", false)]), payload: { _ in 0 })
        let a = q.items[0].id
        _ = q.beginEditing(a)
        XCTAssertTrue(q.beginHubSendNow(q.items[1].id))
        q.enqueue(text: "offline", payload: 9, requestID: "c", origin: QueuedOrigin(pendingUpload: true))
        // The hub moved b first after Send Now, and has not seen c.
        q.mirror(hub([("b", "two", "queued", false), ("a", "one", "queued", true)], revision: 2), payload: { _ in 0 })
        XCTAssertEqual(q.items.map(\.requestID), ["b", "a", "c"], "hub order, then what it has not accepted")
        XCTAssertEqual(q.editingID, a, "the open editor survives a refresh")
        XCTAssertEqual(q.items[0].sendNow, .requesting)
        XCTAssertEqual(q.items[2].payload, 9)
        XCTAssertEqual(q.items[2].origin?.pendingUpload, true)
        // Once accepted, it appears once, from the hub.
        q.mirror(hub([("b", "two", "queued", false), ("a", "one", "queued", true), ("c", "offline", "queued", true)], revision: 3), payload: { _ in 0 })
        XCTAssertEqual(q.items.map(\.requestID), ["b", "a", "c"])
        XCTAssertEqual(q.items[2].origin?.pendingUpload, false)
    }

    func testMirrorDropsItemsThatRanOrWereRemovedElsewhereAndClosesTheirEditor() {
        var q = QueuedTurnQueue<Int>()
        q.mirror(hub([("a", "one", "queued", true), ("b", "two", "queued", false)]), payload: { _ in 0 })
        _ = q.beginEditing(q.items[1].id)
        q.mirror(hub([("a", "one", "queued", true)], revision: 2), payload: { _ in 0 })
        XCTAssertEqual(q.items.map(\.requestID), ["a"])
        XCTAssertNil(q.editingID)
    }

    func testMirrorSkipsMessagesAlreadyShownAsSentInThisChat() {
        var q = QueuedTurnQueue<Int>()
        q.mirror(hub([("a", "streamed here", "queued", true), ("b", "two", "queued", false)]), payload: { _ in 0 }, skip: ["a"])
        XCTAssertEqual(q.items.map(\.requestID), ["b"])
    }

    func testHubSnapshotDecodesAndRefusalsReadPlainly() throws {
        let json = #"{"revision":4,"items":[{"requestId":"ios-1","text":"hi","attachmentCount":0,"source":{"device":"phone","name":"iPhone","nodeId":"mobile:x"},"mine":true,"state":"running","position":0,"revision":1,"createdAt":"x","updatedAt":"y"}]}"#
        let snapshot = try JSONDecoder().decode(HubQueueSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.running?.requestId, "ios-1")
        XCTAssertEqual(TurnInterruptOutcome.fromServer(status: "next", tool: nil), .nothingRunning)
        XCTAssertEqual(QueuedSendNowState.answered(.nothingRunning).label, "Nothing was running. This sends next.")
        XCTAssertTrue(HubQueueRefusal.message(code: "conflict", fallback: nil).contains("changed on another device"))
        XCTAssertEqual(HubQueueRefusal.message(code: "held", fallback: "Mac is editing that message."), "Mac is editing that message.")
    }

    func testAnOlderSnapshotNeverUndoesANewerOne() {
        var q = QueuedTurnQueue<Int>()
        q.mirror(hub([("a", "accepted", "queued", true)], revision: 7), payload: { _ in 0 })
        q.mirror(hub([], revision: 5), payload: { _ in 0 })
        XCTAssertEqual(q.items.map(\.requestID), ["a"], "a slow refresh from before the enqueue is ignored")
        q.mirror(hub([], revision: 8), payload: { _ in 0 })
        XCTAssertTrue(q.items.isEmpty)
    }

    func testUploadsStopAtAMessageWhoseEditorIsOpenAndNothingPassesIt() {
        var q = QueuedTurnQueue<Int>()
        let first = q.enqueue(text: "first", payload: 0, requestID: "p1", origin: QueuedOrigin(pendingUpload: true))
        q.enqueue(text: "second", payload: 0, requestID: "p2", origin: QueuedOrigin(pendingUpload: true))
        XCTAssertEqual(q.nextUpload?.requestID, "p1")
        _ = q.beginEditing(first)
        XCTAssertNil(q.nextUpload, "not the old text mid-edit, and not the one behind it")
        XCTAssertTrue(q.saveEdit(first, text: "first, fixed"))
        XCTAssertEqual(q.nextUpload?.text, "first, fixed")
    }
}
