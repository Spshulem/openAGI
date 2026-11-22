import XCTest
@testable import OpenAGI

// The owner's report: dictate, pause about a second, keep talking. iOS
// finalizes the first segment and starts a fresh transcript for the next one;
// every word must stay, in order, in the same unsent draft.
final class DictationTranscriptTests: XCTestCase {
    func testAPauseFinalizesASegmentAndLaterSpeechIsAppendedNotReplaced() {
        var t = DictationTranscript(base: "")
        XCTAssertEqual(t.receive("Before the", isFinal: false), "Before the")
        XCTAssertEqual(t.receive("Before the pause.", isFinal: true), "Before the pause.")
        // The next utterance's transcript starts from empty.
        XCTAssertEqual(t.receive("After", isFinal: false), "Before the pause. After")
        XCTAssertEqual(t.receive("After the pause it continues.", isFinal: false), "Before the pause. After the pause it continues.")
    }

    func testANewUtteranceWithoutAFinalMarkerStillKeepsWhatCameBefore() {
        var t = DictationTranscript(base: "")
        _ = t.receive("First thought", isFinal: false)
        XCTAssertEqual(t.receive("Second", isFinal: false, startsNewUtterance: true), "First thought Second")
    }

    func testRevisionsWhileSpeakingReplaceOnlyTheLiveSegment() {
        var t = DictationTranscript(base: "")
        _ = t.receive("Kept.", isFinal: true)
        _ = t.receive("I want to", isFinal: false)
        XCTAssertEqual(t.receive("I wanted two", isFinal: false), "Kept. I wanted two", "the recognizer may revise the live words")
        XCTAssertEqual(t.receive("I wanted to go.", isFinal: true), "Kept. I wanted to go.")
    }

    func testTheDraftTypedBeforeDictationIsPreserved() {
        var t = DictationTranscript(base: "Typed first")
        _ = t.receive("then spoken.", isFinal: true)
        XCTAssertEqual(t.receive("And more", isFinal: false), "Typed first then spoken. And more")
        var spaced = DictationTranscript(base: "Typed ")
        XCTAssertEqual(spaced.receive("spoken", isFinal: false), "Typed spoken")
    }

    func testAnEmptyFinalSegmentAddsNothing() {
        var t = DictationTranscript(base: "")
        _ = t.receive("Hello.", isFinal: true)
        XCTAssertEqual(t.receive("", isFinal: true), "Hello.")
        XCTAssertEqual(t.receive("Again", isFinal: false), "Hello. Again")
    }

    // Codex review on #341: on-device partials often have zero timing. A
    // plain revision must not be taken for a new utterance and duplicated.
    func testZeroTimingRevisionsAreNeverANewUtterance() {
        var t = DictationTranscript(base: "")
        var previousEnd: TimeInterval?
        var draft = ""
        for text in ["Before", "Before the", "Before the pause"] {
            let segments: [(TimeInterval, TimeInterval)] = text.split(separator: " ").map { _ in (0, 0) }
            let fresh = DictationTranscript.startsNewUtterance(previousEnd: previousEnd, segments: segments, live: t.live, text: text)
            XCTAssertFalse(fresh, "unset timing must never start a new utterance")
            if let end = DictationTranscript.speechEnd(of: segments) { previousEnd = end }
            draft = t.receive(text, isFinal: false, startsNewUtterance: fresh)
        }
        XCTAssertEqual(draft, "Before the pause")
        XCTAssertNil(previousEnd, "zero timing is never recorded as where speech ended")
    }

    func testRevisionsWithRealTimingAreNotANewUtterance() {
        // Same utterance: the first word keeps its start; later words extend it.
        XCTAssertFalse(DictationTranscript.startsNewUtterance(previousEnd: 0.9, segments: [(0.2, 0.5), (0.5, 0.9), (0.9, 1.4)],
                                                             live: "Before the", text: "Before the pause"))
        // Timing advanced but the text continues the live words: still a revision.
        XCTAssertFalse(DictationTranscript.startsNewUtterance(previousEnd: 0.9, segments: [(1.5, 1.8)],
                                                             live: "Before the", text: "Before the pause"))
    }

    func testANewUtteranceNeedsRealTimingThatStartsAfterAGap() {
        XCTAssertTrue(DictationTranscript.startsNewUtterance(previousEnd: 1.4, segments: [(2.6, 2.9), (2.9, 3.3)],
                                                            live: "Before the pause", text: "After the pause"))
        XCTAssertFalse(DictationTranscript.startsNewUtterance(previousEnd: 1.4, segments: [(1.5, 1.8)],
                                                             live: "Before the pause", text: "After"), "no real gap")
        XCTAssertFalse(DictationTranscript.startsNewUtterance(previousEnd: nil, segments: [(2.6, 2.9)],
                                                             live: "", text: "After"), "nothing heard before")
        XCTAssertFalse(DictationTranscript.startsNewUtterance(previousEnd: 1.4, segments: [(2.6, 2.6)],
                                                             live: "Before", text: "After"), "zero duration is unset timing")
    }

    func testSilenceTimeoutCommitsLiveWordsAndClassifiesRecoverablePauseErrors() {
        var t = DictationTranscript(base: "Initial:")
        _ = t.receive("spoken before silence", isFinal: false)
        XCTAssertEqual(t.commitLive(), "Initial: spoken before silence")
        XCTAssertEqual(t.receive("and after silence", isFinal: false), "Initial: spoken before silence and after silence")

        let noSpeech = NSError(domain: "kAFAssistantErrorDomain", code: 1110, userInfo: [NSLocalizedDescriptionKey: "No speech detected"])
        XCTAssertTrue(ChatDictation.isRecoverablePauseError(noSpeech))

        let canceled = NSError(domain: "kAFAssistantErrorDomain", code: 216, userInfo: [NSLocalizedDescriptionKey: "Recognition request was canceled"])
        XCTAssertTrue(ChatDictation.isRecoverablePauseError(canceled))

        let fatalHardware = NSError(domain: "AVAudioEngineErrorDomain", code: -10851, userInfo: [NSLocalizedDescriptionKey: "Hardware unavailable"])
        XCTAssertFalse(ChatDictation.isRecoverablePauseError(fatalHardware))
    }
}
