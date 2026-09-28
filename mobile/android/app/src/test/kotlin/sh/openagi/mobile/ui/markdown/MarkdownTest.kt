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

    // What agents actually write: headings, tables, quotes, rules, nested and
    // task lists, italic and strikethrough. None of it may render raw.
    @Test
    fun headingsQuotesAndRulesAreBlocksNotRawText() {
        val blocks = Markdown.parse("## Status\n> Waiting on CI\n---\nDone")
        assertEquals(MarkdownBlock.Heading(2, listOf(InlineSpan.Text("Status"))), blocks[0])
        assertEquals(MarkdownBlock.Quote(listOf(InlineSpan.Text("Waiting on CI"))), blocks[1])
        assertEquals(MarkdownBlock.Rule, blocks[2])
        assertEquals(MarkdownBlock.Paragraph(listOf(InlineSpan.Text("Done"))), blocks[3])
    }

    @Test
    fun aPipeTableBecomesATable() {
        val table = Markdown.parse("| PR | CI |\n|---|:--:|\n| #7 | **green** |\n| #8 | red |").single() as MarkdownBlock.Table
        assertEquals(listOf(listOf(InlineSpan.Text("PR")), listOf(InlineSpan.Text("CI"))), table.header)
        assertEquals(2, table.rows.size)
        assertEquals(listOf(InlineSpan.Bold("green")), table.rows[0][1])
    }

    @Test
    fun nestedAndTaskListsKeepTheirDepthAndState() {
        val blocks = Markdown.parse("- top\n  - nested\n- [x] done\n- [ ] todo\n1. first\n   2. inner")
        assertEquals(MarkdownBlock.Bullet(listOf(InlineSpan.Text("top")), 0), blocks[0])
        assertEquals(MarkdownBlock.Bullet(listOf(InlineSpan.Text("nested")), 1), blocks[1])
        assertEquals(MarkdownBlock.Bullet(listOf(InlineSpan.Text("done")), 0, true), blocks[2])
        assertEquals(MarkdownBlock.Bullet(listOf(InlineSpan.Text("todo")), 0, false), blocks[3])
        assertEquals(1, (blocks[5] as MarkdownBlock.Numbered).depth)
    }

    @Test
    fun italicStrikeAndBareLinksParseButSnakeCaseStaysPlain() {
        val spans = (Markdown.parse("an *important* ~~old~~ note_about_names see https://github.com/x/y/pull/7.").single() as MarkdownBlock.Paragraph).spans
        assertTrue(spans.contains(InlineSpan.Italic("important")))
        assertTrue(spans.contains(InlineSpan.Strike("old")))
        assertTrue(spans.contains(InlineSpan.Link("https://github.com/x/y/pull/7", "https://github.com/x/y/pull/7")))
        assertTrue(spans.filterIsInstance<InlineSpan.Text>().any { "note_about_names" in it.text })
        assertTrue(spans.none { it is InlineSpan.Text && ("*" in it.text || "~~" in it.text) })
    }
}
