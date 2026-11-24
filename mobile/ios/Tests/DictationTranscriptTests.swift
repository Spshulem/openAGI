import XCTest
@testable import OpenAGI

// The owner's report: dictate, pause about a second, keep talking. iOS
// finalizes the first segment and starts a fresh transcript for the next one;
// every word must stay, in order, in the same unsent draft.
final class DictationTranscriptTests: XCTestCase {
    // The owner's report after #341, through the built-in composer mic: on
    // device a pause often ends an utterance without isFinal and without
    // timing; the next partial restarts from empty. The earlier words must
    // stay, and the new ones append without duplication.
    // Each step: text, whether iOS ended the utterance, seconds since the
    // previous result, and whether it was final.
    private func feed(_ steps: [(String, Bool)], base: String = "", gap: TimeInterval = 0.2,
                      pauses: Set<Int> = []) -> String {
        var t = DictationTranscript(base: base)
        var draft = base
        for (i, (text, ends)) in steps.enumerated() {
            let fresh = DictationTranscript.startsNewUtterance(previousEnd: nil, segments: [], live: t.live, text: text,
                                                               sinceLastResult: pauses.contains(i) ? 1.2 : gap)
            draft = t.receive(text, isFinal: false, startsNewUtterance: fresh, endsUtterance: ends)
        }
        return draft
    }

    func testARestartWithoutFinalOrTimingKeepsTheEarlierWords() {
        XCTAssertEqual(feed([("Before", false), ("Before the pause", false), ("After", false), ("After the pause it continues", false)],
                            pauses: [2]),
                       "Before the pause After the pause it continues")
    }

    func testAnUtteranceEndMarkerCommitsTheWordsHeardSoFar() {
        // iOS 17+ marks the end of an utterance with speech metadata.
        XCTAssertEqual(feed([("Before the pause.", true), ("After", false), ("After the pause.", false)]),
                       "Before the pause. After the pause.")
    }

    func testACumulativeTranscriptAfterAnUtteranceEndIsNotDuplicated() {
        // Some results repeat everything heard; nothing may appear twice.
        XCTAssertEqual(feed([("Before the pause.", true), ("Before the pause. After", false),
                             ("Before the pause. After the pause.", false)]),
                       "Before the pause. After the pause.")
    }

    // Known limit: a one-word utterance cannot be told apart from a revision
    // of that word without timing or an utterance-end marker.
    func testRevisionsWithoutTimingStillReplaceOnlyTheLiveWords() {
        XCTAssertEqual(feed([("I want to", false), ("I wanted two", false), ("I wanted to go", false)]), "I wanted to go")
        XCTAssertEqual(feed([("Before", false), ("Before the", false), ("Before the pause", false)]), "Before the pause")
    }

    // Codex review on #364: a correction that merges words is not a restart
    // when no silence came before it.
    func testAWordBoundaryCorrectionWithoutAPauseIsARevision() {
        XCTAssertEqual(feed([("some thing", false), ("something", false), ("something else", false)]), "something else")
    }

    // Codex review on #364: saying the same thing again in a fresh request
    // (after a final result) keeps both.
    func testRepeatingTheSameWordsAfterAFinalResultKeepsBoth() {
        var t = DictationTranscript(base: "")
        _ = t.receive("No.", isFinal: true)
        XCTAssertEqual(t.receive("No.", isFinal: true), "No. No.")
    }

    // Codex review on #364: cumulative results across several utterance
    // ends drop everything already committed in that request.
    func testCumulativeResultsAcrossSeveralUtteranceEndsAreNotDuplicated() {
        XCTAssertEqual(feed([("First thought.", true), ("First thought. Second thought.", true),
                             ("First thought. Second thought. Third thought.", true)]),
                       "First thought. Second thought. Third thought.")
    }

    func testTypedDraftThenTwoUtterancesAcrossAPause() {
        // Partials grow word by word, so a restart begins with a short result.
        XCTAssertEqual(feed([("First", false), ("First part", false), ("Second", false), ("Second part", false)], base: "Typed",
                            pauses: [2]),
                       "Typed First part Second part")
    }

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

    // Codex review on #341: consecutive utterances that share a first word
    // are still two utterances when real timing says so.
    func testConsecutiveUtterancesThatShareAFirstWordAreBothKept() {
        var t = DictationTranscript(base: "")
        _ = t.receive("I need milk", isFinal: false)
        let fresh = DictationTranscript.startsNewUtterance(previousEnd: 1.4, segments: [(2.6, 2.8), (2.8, 3.2)],
                                                           live: t.live, text: "I also need bread")
        XCTAssertTrue(fresh)
        XCTAssertEqual(t.receive("I also need bread", isFinal: false, startsNewUtterance: fresh), "I need milk I also need bread")
        // A true extension of the live text, even after a gap, stays one utterance.
        XCTAssertFalse(DictationTranscript.startsNewUtterance(previousEnd: 1.4, segments: [(2.6, 2.8)],
                                                             live: "I need milk", text: "I need milk and eggs."))
    }

    // A long silence: the waiting request fails ("no speech"). What it heard
    // stays, and the next request's speech is appended.
    func testAFailedRequestKeepsWhatItHeard() {
        var t = DictationTranscript(base: "")
        _ = t.receive("Before.", isFinal: true)
        _ = t.receive("Half a", isFinal: false)
        XCTAssertEqual(t.endSegment(), "Before. Half a")
        XCTAssertEqual(t.receive("Still here.", isFinal: false), "Before. Half a Still here.")
        XCTAssertEqual(t.endSegment(), "Before. Half a Still here.")
        XCTAssertEqual(t.endSegment(), "Before. Half a Still here.", "an empty segment adds nothing")
    }

    // Review fix (#343): words an utterance-end marker kept in the failed
    // request are not stripped from the replacement request's fresh results.
    func testAReplacementRequestKeepsWordsThatRepeatTheFailedRequest() {
        var t = DictationTranscript(base: "")
        XCTAssertEqual(t.receive("No.", isFinal: false, endsUtterance: true), "No.")
        XCTAssertEqual(t.endSegment(), "No.")
        XCTAssertEqual(t.receive("No.", isFinal: false), "No. No.")
    }

    func testOnlyAStoppedMicrophoneOrRepeatedImmediateFailuresEndDictation() {
        let silence = ChatDictation.failureEndsDictation(listenedFor: 8, quickFailures: 2, microphoneRunning: true)
        XCTAssertFalse(silence.ends, "a failure after a long silence keeps listening")
        XCTAssertEqual(silence.quickFailures, 0, "and clears earlier immediate failures")
        var count = 0
        for attempt in 1...ChatDictation.quickFailureLimit {
            let decision = ChatDictation.failureEndsDictation(listenedFor: 0.2, quickFailures: count, microphoneRunning: true)
            count = decision.quickFailures
            XCTAssertEqual(decision.ends, attempt == ChatDictation.quickFailureLimit, "attempt \(attempt)")
        }
        XCTAssertTrue(ChatDictation.failureEndsDictation(listenedFor: 8, quickFailures: 0, microphoneRunning: false).ends,
                      "a stopped microphone ends dictation")
    }



    func testImmediateFailuresWaitLongerBeforeTheNextTry() {
        XCTAssertEqual(ChatDictation.retryDelay(afterQuickFailures: 1), 250)
        XCTAssertEqual(ChatDictation.retryDelay(afterQuickFailures: 2), 500)
    }
}
