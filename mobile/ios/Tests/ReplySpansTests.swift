import XCTest
@testable import OpenAGI

// An interruption reports how much of the reply being heard was played; the
// hub truncates the model's copy of the reply there. Codex review on #338:
// reply.done used to clear the origin while audio was still playing, so an
// interruption then reported zero and the whole reply was cut.
final class ReplySpansTests: XCTestCase {
    func testInterruptingAfterReplyDoneButBeforePlaybackEndsReportsWhatWasHeard() {
        var spans = ReplySpans()
        spans.audioScheduled(at: 1_000)
        spans.audioScheduled(at: 25_000)
        spans.replyDone(endingAt: 73_000)
        XCTAssertEqual(spans.heard(at: 49_000), 48_000, "still playing: heard from the reply's start")
    }

    func testTheNextReplyStartsItsOwnSpan() {
        var spans = ReplySpans()
        spans.audioScheduled(at: 0)
        spans.replyDone(endingAt: 24_000)
        spans.audioScheduled(at: 24_000)
        XCTAssertEqual(spans.heard(at: 12_000), 12_000, "first reply still playing")
        XCTAssertEqual(spans.heard(at: 30_000), 6_000, "second reply measured from its own start")
    }

    func testPlayedRepliesAreDroppedAndResetClearsEverything() {
        var spans = ReplySpans()
        spans.audioScheduled(at: 0)
        spans.replyDone(endingAt: 24_000)
        spans.played(through: 24_000)
        XCTAssertEqual(spans, ReplySpans())
        XCTAssertEqual(spans.heard(at: 30_000), 0, "nothing playing, nothing heard")
        spans.audioScheduled(at: 30_000)
        spans.reset()
        XCTAssertEqual(spans.heard(at: 40_000), 0)
    }
}
