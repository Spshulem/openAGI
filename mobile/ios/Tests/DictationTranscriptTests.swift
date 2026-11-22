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
}
