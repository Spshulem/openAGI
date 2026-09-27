import XCTest
@testable import OpenAGI

// DESIGN.md's Chat section: "Assistant replies render Markdown -- bold,
// inline code, fenced code blocks, bullet and numbered lists, links. A
// reply full of raw `**asterisks**` is the clearest possible sign the app
// does not understand its own content." These pin `MarkdownParser`'s block
// splitting directly, independent of SwiftUI, the same way `RelativeTime`
// and `ConnectionDotState` are tested elsewhere in this suite.
final class MarkdownParserTests: XCTestCase {
    func testAPlainSentenceIsOneParagraph() {
        XCTAssertEqual(MarkdownParser.parse("Hello there."), [.paragraph("Hello there.")])
    }

    // Soft-wrapped lines within one paragraph join into a single block --
    // otherwise every line break in an assistant reply would render as its
    // own separate paragraph with extra vertical gaps.
    func testWrappedLinesInOneParagraphJoinWithASpace() {
        XCTAssertEqual(MarkdownParser.parse("Line one\nLine two"), [.paragraph("Line one Line two")])
    }

    func testABlankLineSeparatesTwoParagraphs() {
        XCTAssertEqual(MarkdownParser.parse("First.\n\nSecond."), [.paragraph("First."), .paragraph("Second.")])
    }

    func testABulletListIsExtractedAsOneBlock() {
        let blocks = MarkdownParser.parse("- one\n- two\n- three")
        XCTAssertEqual(blocks, [.bulletList(["one", "two", "three"])])
    }

    func testBulletMarkersStarAndPlusAllCount() {
        XCTAssertEqual(MarkdownParser.parse("* a\n+ b"), [.bulletList(["a", "b"])])
    }

    func testANumberedListIsExtractedAsOneBlock() {
        let blocks = MarkdownParser.parse("1. first\n2. second")
        XCTAssertEqual(blocks, [.numberedList(["first", "second"])])
    }

    // A run of digits that isn't actually a list marker (no following
    // space, or not immediately after the dot) must not be misread as one.
    func testANumberFollowedByAWordIsNotAListItem() {
        XCTAssertEqual(MarkdownParser.parse("3.5 is a version"), [.paragraph("3.5 is a version")])
    }

    func testAFencedCodeBlockIsExtractedWithItsLanguage() {
        let text = "Before.\n```swift\nlet x = 1\nprint(x)\n```\nAfter."
        let blocks = MarkdownParser.parse(text)
        XCTAssertEqual(blocks, [
            .paragraph("Before."),
            .codeBlock(language: "swift", code: "let x = 1\nprint(x)"),
            .paragraph("After.")
        ])
    }

    func testAFencedCodeBlockWithNoLanguageDecodesANilLanguage() {
        guard case let .codeBlock(language, code)? = MarkdownParser.parse("```\nplain\n```").first else {
            return XCTFail("expected a code block")
        }
        XCTAssertNil(language)
        XCTAssertEqual(code, "plain")
    }

    // An unterminated fence (the daemon's stream ends mid code block, or a
    // model simply forgets the closing "```") must still surface the code
    // that arrived rather than swallowing the rest of the reply.
    func testAnUnterminatedFenceStillYieldsItsContent() {
        let blocks = MarkdownParser.parse("```python\nprint(1)")
        XCTAssertEqual(blocks, [.codeBlock(language: "python", code: "print(1)")])
    }

    func testAMixOfBlocksSplitsInOrder() {
        let text = "Summary:\n\n- did the thing\n- did another thing\n\n```\ncode here\n```\n\nDone."
        let blocks = MarkdownParser.parse(text)
        XCTAssertEqual(blocks, [
            .paragraph("Summary:"),
            .bulletList(["did the thing", "did another thing"]),
            .codeBlock(language: nil, code: "code here"),
            .paragraph("Done.")
        ])
    }

    // Inline spans (bold, code, links) are handed to
    // `AttributedString(markdown:)` rather than parsed by hand -- this pins
    // that a raw `**bold**` marker is actually consumed into a bold run,
    // not left as literal asterisks in the rendered text (the failure mode
    // DESIGN.md calls out by name).
    func testInlineBoldIsNotLeftAsLiteralAsterisks() {
        let attributed = MarkdownParser.inline("This is **bold** text.")
        let plain = String(attributed.characters)
        XCTAssertEqual(plain, "This is bold text.")
        XCTAssertFalse(plain.contains("**"))
    }

    func testInlineCodeSpanIsNotLeftAsLiteralBackticks() {
        let attributed = MarkdownParser.inline("Run `swift build` now.")
        let plain = String(attributed.characters)
        XCTAssertEqual(plain, "Run swift build now.")
        XCTAssertFalse(plain.contains("`"))
    }
}
