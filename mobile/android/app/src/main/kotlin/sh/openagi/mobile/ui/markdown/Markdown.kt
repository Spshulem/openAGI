package sh.openagi.mobile.ui.markdown

// DESIGN.md's Chat section: "Assistant replies render Markdown — bold,
// inline code, fenced code blocks, bullet and numbered lists, links. A
// reply full of raw `**asterisks**` is the clearest possible sign the app
// does not understand its own content." Compose has no built-in Markdown
// renderer and this project may not add a dependency for one, so this is a
// small hand-written parser for what agents actually write: headings,
// tables, quotes, rules, nested and task lists, italic and strikethrough on
// top of DESIGN.md's list — not a CommonMark implementation. It is pure Kotlin (no android.*, no
// androidx.compose.*) so it is trivially unit-testable; ChatScreen turns
// these blocks into an AnnotatedString.

/** One inline run within a paragraph, bullet item, or numbered item. */
sealed class InlineSpan {
    data class Text(val text: String) : InlineSpan()
    data class Bold(val text: String) : InlineSpan()
    data class Code(val text: String) : InlineSpan()
    data class Link(val text: String, val url: String) : InlineSpan()
    data class Italic(val text: String) : InlineSpan()
    data class Strike(val text: String) : InlineSpan()
}

/** One block of a parsed reply, in source order. */
sealed class MarkdownBlock {
    data class Paragraph(val spans: List<InlineSpan>) : MarkdownBlock()
    // depth: 0 for a top-level item, 1+ for items indented under it.
    // checked: null for a plain item, true/false for a "- [x]" / "- [ ]" task.
    data class Bullet(val spans: List<InlineSpan>, val depth: Int = 0, val checked: Boolean? = null) : MarkdownBlock()
    data class Numbered(val index: Int, val spans: List<InlineSpan>, val depth: Int = 0) : MarkdownBlock()
    data class CodeBlock(val code: String, val language: String? = null) : MarkdownBlock()
    data class Heading(val level: Int, val spans: List<InlineSpan>) : MarkdownBlock()
    data class Quote(val spans: List<InlineSpan>) : MarkdownBlock()
    data class Table(val header: List<List<InlineSpan>>, val rows: List<List<List<InlineSpan>>>) : MarkdownBlock()
    object Rule : MarkdownBlock()
}

object Markdown {
    private val fence = Regex("^```(\\w*)\\s*$")
    private val bullet = Regex("^(\\s*)[-*+]\\s+(.*)$")
    private val numbered = Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$")
    private val heading = Regex("^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
    private val quote = Regex("^\\s{0,3}>\\s?(.*)$")
    private val rule = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
    private val tableSeparator = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")
    private val task = Regex("^\\[([ xX])]\\s+(.*)$")

    // Priority, left to right: inline code first (its contents are never
    // parsed further), then bold, then a link, matching the exact surface
    // DESIGN.md asks for. No italics: a single `*`/`_` is already claimed by
    // bullet-line detection and CommonMark's own italics/bullet ambiguity
    // isn't worth resolving for a chat reply DESIGN.md doesn't ask to render
    // italic in the first place.
    // Groups: 1 code, 2/3 bold, 4-5 link, 6 strike, 7/8 italic, 9 bare URL.
    // Italic needs a non-word character (or an edge) around it, so
    // snake_case_names and 2*3*4 stay plain text.
    private val inline = Regex(
        "`([^`]+)`" +
            "|\\*\\*([^*]+)\\*\\*" +
            "|__([^_]+)__" +
            "|\\[([^\\]]+)]\\(([^)\\s]+)\\)" +
            "|~~([^~]+)~~" +
            "|(?<![\\w*])\\*([^*\\s][^*\\n]*?)\\*(?![\\w*])" +
            "|(?<![\\w_])_([^_\\s][^_\\n]*?)_(?![\\w_])" +
            "|(https?://[^\\s)>\\]]+[^\\s)>\\].,;:!?'\"])",
    )

    private fun depthOf(indent: String): Int = (indent.replace("\t", "    ").length / 2).coerceAtMost(4)

    private fun cells(line: String): List<String> =
        line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

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

            // A table: a pipe row followed by a --- separator row.
            if (line.contains('|') && i + 1 < lines.size && tableSeparator.matches(lines[i + 1]) && cells(line).size > 1) {
                flushParagraph()
                val header = cells(line).map { parseInline(it) }
                val rows = mutableListOf<List<List<InlineSpan>>>()
                i += 2
                while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                    rows += cells(lines[i]).map { parseInline(it) }
                    i++
                }
                blocks += MarkdownBlock.Table(header, rows)
                continue
            }

            val headingMatch = heading.find(line)
            val quoteMatch = quote.find(line)
            val bulletMatch = bullet.find(line)
            val numberedMatch = numbered.find(line)
            when {
                line.isBlank() -> flushParagraph()
                rule.matches(line) -> {
                    flushParagraph()
                    blocks += MarkdownBlock.Rule
                }
                headingMatch != null -> {
                    flushParagraph()
                    blocks += MarkdownBlock.Heading(headingMatch.groupValues[1].length, parseInline(headingMatch.groupValues[2]))
                }
                quoteMatch != null -> {
                    flushParagraph()
                    blocks += MarkdownBlock.Quote(parseInline(quoteMatch.groupValues[1]))
                }
                bulletMatch != null -> {
                    flushParagraph()
                    val body = bulletMatch.groupValues[2]
                    val taskMatch = task.find(body)
                    blocks += if (taskMatch != null) {
                        MarkdownBlock.Bullet(parseInline(taskMatch.groupValues[2]), depthOf(bulletMatch.groupValues[1]), taskMatch.groupValues[1] != " ")
                    } else {
                        MarkdownBlock.Bullet(parseInline(body), depthOf(bulletMatch.groupValues[1]))
                    }
                }
                numberedMatch != null -> {
                    flushParagraph()
                    val index = numberedMatch.groupValues[2].toIntOrNull() ?: (blocks.count { it is MarkdownBlock.Numbered } + 1)
                    blocks += MarkdownBlock.Numbered(index, parseInline(numberedMatch.groupValues[3]), depthOf(numberedMatch.groupValues[1]))
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
                groups[6].isNotEmpty() -> spans += InlineSpan.Strike(groups[6])
                groups[7].isNotEmpty() -> spans += InlineSpan.Italic(groups[7])
                groups[8].isNotEmpty() -> spans += InlineSpan.Italic(groups[8])
                groups[9].isNotEmpty() -> spans += InlineSpan.Link(groups[9], groups[9])
                else -> spans += InlineSpan.Text(match.value)
            }
            lastEnd = match.range.last + 1
        }
        if (lastEnd < text.length) spans += InlineSpan.Text(text.substring(lastEnd))
        if (spans.isEmpty()) spans += InlineSpan.Text(text)
        return spans
    }
}
