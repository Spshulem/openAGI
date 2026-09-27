package sh.openagi.mobile.ui.markdown

// DESIGN.md's Chat section: "Assistant replies render Markdown — bold,
// inline code, fenced code blocks, bullet and numbered lists, links. A
// reply full of raw `**asterisks**` is the clearest possible sign the app
// does not understand its own content." Compose has no built-in Markdown
// renderer and this project may not add a dependency for one, so this is a
// small hand-written parser covering exactly the syntax DESIGN.md names —
// not a CommonMark implementation. It is pure Kotlin (no android.*, no
// androidx.compose.*) so it is trivially unit-testable; ChatScreen turns
// these blocks into an AnnotatedString.

/** One inline run within a paragraph, bullet item, or numbered item. */
sealed class InlineSpan {
    data class Text(val text: String) : InlineSpan()
    data class Bold(val text: String) : InlineSpan()
    data class Code(val text: String) : InlineSpan()
    data class Link(val text: String, val url: String) : InlineSpan()
}

/** One block of a parsed reply, in source order. */
sealed class MarkdownBlock {
    data class Paragraph(val spans: List<InlineSpan>) : MarkdownBlock()
    data class Bullet(val spans: List<InlineSpan>) : MarkdownBlock()
    data class Numbered(val index: Int, val spans: List<InlineSpan>) : MarkdownBlock()
    data class CodeBlock(val code: String, val language: String? = null) : MarkdownBlock()
}

object Markdown {
    private val fence = Regex("^```(\\w*)\\s*$")
    private val bullet = Regex("^\\s{0,3}[-*+]\\s+(.*)$")
    private val numbered = Regex("^\\s{0,3}(\\d+)[.)]\\s+(.*)$")

    // Priority, left to right: inline code first (its contents are never
    // parsed further), then bold, then a link, matching the exact surface
    // DESIGN.md asks for. No italics: a single `*`/`_` is already claimed by
    // bullet-line detection and CommonMark's own italics/bullet ambiguity
    // isn't worth resolving for a chat reply DESIGN.md doesn't ask to render
    // italic in the first place.
    private val inline = Regex(
        "`([^`]+)`" +
            "|\\*\\*([^*]+)\\*\\*" +
            "|__([^_]+)__" +
            "|\\[([^\\]]+)]\\(([^)]+)\\)",
    )

    fun parse(text: String): List<MarkdownBlock> {
        val blocks = mutableListOf<MarkdownBlock>()
        val paragraph = mutableListOf<String>()

        fun flushParagraph() {
            if (paragraph.isNotEmpty()) {
                blocks += MarkdownBlock.Paragraph(parseInline(paragraph.joinToString("\n")))
                paragraph.clear()
            }
        }

        val lines = text.replace("\r\n", "\n").split("\n")
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val fenceMatch = fence.find(line.trim())
            if (fenceMatch != null) {
                flushParagraph()
                val language = fenceMatch.groupValues[1].ifBlank { null }
                val code = mutableListOf<String>()
                i++
                while (i < lines.size && lines[i].trim() != "```") {
                    code.add(lines[i])
                    i++
                }
                blocks += MarkdownBlock.CodeBlock(code.joinToString("\n"), language)
                i++ // skip the closing fence; harmless if unterminated (i == lines.size)
                continue
            }

            val bulletMatch = bullet.find(line)
            val numberedMatch = numbered.find(line)
            when {
                line.isBlank() -> flushParagraph()
                bulletMatch != null -> {
                    flushParagraph()
                    blocks += MarkdownBlock.Bullet(parseInline(bulletMatch.groupValues[1]))
                }
                numberedMatch != null -> {
                    flushParagraph()
                    val index = numberedMatch.groupValues[1].toIntOrNull() ?: (blocks.count { it is MarkdownBlock.Numbered } + 1)
                    blocks += MarkdownBlock.Numbered(index, parseInline(numberedMatch.groupValues[2]))
                }
                else -> paragraph.add(line)
            }
            i++
        }
        flushParagraph()
        return blocks
    }

    private fun parseInline(text: String): List<InlineSpan> {
        val spans = mutableListOf<InlineSpan>()
        var lastEnd = 0
        for (match in inline.findAll(text)) {
            if (match.range.first > lastEnd) {
                spans += InlineSpan.Text(text.substring(lastEnd, match.range.first))
            }
            val groups = match.groupValues
            when {
                groups[1].isNotEmpty() -> spans += InlineSpan.Code(groups[1])
                groups[2].isNotEmpty() -> spans += InlineSpan.Bold(groups[2])
                groups[3].isNotEmpty() -> spans += InlineSpan.Bold(groups[3])
                groups[4].isNotEmpty() -> spans += InlineSpan.Link(groups[4], groups[5])
                else -> spans += InlineSpan.Text(match.value)
            }
            lastEnd = match.range.last + 1
        }
        if (lastEnd < text.length) spans += InlineSpan.Text(text.substring(lastEnd))
        if (spans.isEmpty()) spans += InlineSpan.Text(text)
        return spans
    }
}
