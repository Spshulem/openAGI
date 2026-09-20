package sh.openagi.mobile.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// DESIGN.md's Chat section: "Assistant replies render Markdown — bold,
// inline code, fenced code blocks, bullet and numbered lists, links. A reply
// full of raw `**asterisks**` is the clearest possible sign the app does not
// understand its own content." These pin the parser against exactly that
// symptom: raw markup must never survive into a rendered span as literal
// syntax characters.
class MarkdownTest {
    @Test
    fun plainTextIsOneParagraphWithOneTextSpan() {
        val blocks = Markdown.parse("Hello there")
        assertEquals(1, blocks.size)
        val paragraph = blocks.single() as MarkdownBlock.Paragraph
        assertEquals(listOf(InlineSpan.Text("Hello there")), paragraph.spans)
    }

    @Test
    fun doubleAsteriskBoldNeverSurvivesAsLiteralAsterisks() {
        val blocks = Markdown.parse("This is **important** text")
        val paragraph = blocks.single() as MarkdownBlock.Paragraph
        assertTrue(paragraph.spans.contains(InlineSpan.Bold("important")))
        paragraph.spans.forEach { span ->
            if (span is InlineSpan.Text) assertTrue(!span.text.contains("**"))
        }
    }

    @Test
    fun underscoreBoldIsRecognizedTheSameAsAsterisks() {
        val blocks = Markdown.parse("__important__")
        val paragraph = blocks.single() as MarkdownBlock.Paragraph
        assertEquals(listOf(InlineSpan.Bold("important")), paragraph.spans)
    }

    @Test
    fun inlineCodeIsItsOwnSpanNotLiteralBackticks() {
        val blocks = Markdown.parse("Run `openagi pair-phone` now")
        val paragraph = blocks.single() as MarkdownBlock.Paragraph
        assertTrue(paragraph.spans.contains(InlineSpan.Code("openagi pair-phone")))
        paragraph.spans.forEach { span ->
            if (span is InlineSpan.Text) assertTrue(!span.text.contains("`"))
        }
    }

    @Test
    fun aLinkKeepsItsDisplayTextAndUrlSeparately() {
        val blocks = Markdown.parse("See [the docs](https://example.com/docs) for more")
        val paragraph = blocks.single() as MarkdownBlock.Paragraph
        assertTrue(paragraph.spans.contains(InlineSpan.Link("the docs", "https://example.com/docs")))
    }

    @Test
    fun aFencedCodeBlockKeepsItsLanguageAndBody() {
        val blocks = Markdown.parse(
            """
            Here's a fix:
            ```kotlin
            val x = 1
            println(x)
            ```
            """.trimIndent(),
        )
        val code = blocks.filterIsInstance<MarkdownBlock.CodeBlock>().single()
        assertEquals("kotlin", code.language)
        assertEquals("val x = 1\nprintln(x)", code.code)
    }

    @Test
    fun anUnterminatedFenceStillCapturesEverythingAfterItRatherThanCrashing() {
        val blocks = Markdown.parse("```\nno closing fence\nmore text")
        val code = blocks.filterIsInstance<MarkdownBlock.CodeBlock>().single()
        assertEquals("no closing fence\nmore text", code.code)
    }

    @Test
    fun bulletLinesBecomeBulletBlocksInOrder() {
        val blocks = Markdown.parse("- first\n- second\n* third")
        assertEquals(3, blocks.size)
        assertEquals(InlineSpan.Text("first"), (blocks[0] as MarkdownBlock.Bullet).spans.single())
        assertEquals(InlineSpan.Text("second"), (blocks[1] as MarkdownBlock.Bullet).spans.single())
        assertEquals(InlineSpan.Text("third"), (blocks[2] as MarkdownBlock.Bullet).spans.single())
    }

    @Test
    fun numberedLinesKeepTheirSourceNumber() {
        val blocks = Markdown.parse("2. second\n3. third")
        val first = blocks[0] as MarkdownBlock.Numbered
        val second = blocks[1] as MarkdownBlock.Numbered
        assertEquals(2, first.index)
        assertEquals(3, second.index)
    }

    @Test
    fun aLoneAsteriskLineIsABulletNotItalicOrABareCharacter() {
        // "* item" (marker + space) is a bullet; DESIGN.md doesn't ask this
        // parser to render italics at all, so a single asterisk is never
        // treated as an emphasis delimiter.
        val blocks = Markdown.parse("* item")
        val bullet = blocks.single() as MarkdownBlock.Bullet
        assertEquals(InlineSpan.Text("item"), bullet.spans.single())
    }

    @Test
    fun blankLinesSeparateParagraphsRatherThanMergingThem() {
        val blocks = Markdown.parse("First paragraph\n\nSecond paragraph")
        assertEquals(2, blocks.size)
        assertTrue(blocks.all { it is MarkdownBlock.Paragraph })
    }

    @Test
    fun emptyReplyParsesToNoBlocksRatherThanThrowing() {
        assertEquals(emptyList<MarkdownBlock>(), Markdown.parse(""))
    }
}
