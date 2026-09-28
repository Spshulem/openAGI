package sh.openagi.mobile.ui.markdown

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType

// Renders agent text as Markdown anywhere the app shows it: chat replies,
// a thread's last message, supervisor questions. Links open in the browser.
@Composable
fun MarkdownView(text: String, textColor: Color, modifier: Modifier = Modifier, style: TextStyle = OpenAGIType.body) {
    val blocks = remember(text) { Markdown.parse(text) }
    MarkdownBlocksView(blocks, textColor, modifier, style)
}

@Composable
fun MarkdownBlocksView(blocks: List<MarkdownBlock>, textColor: Color, modifier: Modifier = Modifier, style: TextStyle = OpenAGIType.body) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MarkdownBlock.Paragraph -> Text(renderInline(block.spans, textColor), style = style, color = textColor)
                is MarkdownBlock.Heading -> Text(
                    renderInline(block.spans, textColor),
                    style = style.copy(fontWeight = FontWeight.SemiBold, fontSize = style.fontSize * headingScale(block.level)),
                    color = textColor,
                    modifier = Modifier.padding(top = if (block.level <= 2) 4.dp else 2.dp),
                )
                is MarkdownBlock.Bullet -> Row(
                    modifier = Modifier.padding(start = (block.depth * 16).dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    val marker = when (block.checked) {
                        true -> "☑"
                        false -> "☐"
                        null -> if (block.depth == 0) "•" else "◦"
                    }
                    Text(marker, style = style, color = textColor)
                    Text(renderInline(block.spans, textColor), style = style, color = textColor, modifier = Modifier.weight(1f))
                }
                is MarkdownBlock.Numbered -> Row(
                    modifier = Modifier.padding(start = (block.depth * 16).dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("${block.index}.", style = style, color = textColor)
                    Text(renderInline(block.spans, textColor), style = style, color = textColor, modifier = Modifier.weight(1f))
                }
                is MarkdownBlock.Quote -> Row(modifier = Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(muted.copy(alpha = 0.6f), RoundedCornerShape(2.dp)))
                    Text(renderInline(block.spans, textColor), style = style.copy(fontStyle = FontStyle.Italic), color = muted, modifier = Modifier.weight(1f))
                }
                is MarkdownBlock.Rule -> HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp), color = muted.copy(alpha = 0.4f))
                is MarkdownBlock.Table -> TableView(block, textColor, style)
                is MarkdownBlock.CodeBlock -> CodeBlockView(block.code)
            }
        }
    }
}

private fun headingScale(level: Int): Float = when (level) {
    1 -> 1.3f
    2 -> 1.18f
    3 -> 1.08f
    else -> 1f
}

fun renderInline(spans: List<InlineSpan>, base: Color): AnnotatedString = buildAnnotatedString {
    spans.forEach { span ->
        when (span) {
            is InlineSpan.Text -> append(span.text)
            is InlineSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
            is InlineSpan.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(span.text) }
            is InlineSpan.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(span.text) }
            is InlineSpan.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(span.text) }
            is InlineSpan.Link -> {
                val url = span.url.trim()
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = base, textDecoration = TextDecoration.Underline)))) { append(span.text) }
                } else {
                    withStyle(SpanStyle(color = base, textDecoration = TextDecoration.Underline)) { append(span.text) }
                }
            }
        }
    }
}

// Tables scroll sideways instead of squeezing columns on a phone.
@Composable
private fun TableView(table: MarkdownBlock.Table, textColor: Color, style: TextStyle) {
    val colors = LocalOpenAGIColors.current
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    Surface(color = colors.edge.copy(alpha = 0.35f), shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.horizontalScroll(rememberScrollState()).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(table.header).plus(table.rows).forEachIndexed { rowIndex, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (column in 0 until columns) {
                        val cell = row.getOrNull(column).orEmpty()
                        Text(
                            renderInline(cell, textColor),
                            style = if (rowIndex == 0) style.copy(fontWeight = FontWeight.SemiBold) else style,
                            color = textColor,
                            modifier = Modifier.widthIn(min = 48.dp, max = 220.dp),
                        )
                    }
                }
                if (rowIndex == 0) HorizontalDivider(color = textColor.copy(alpha = 0.2f))
            }
        }
    }
}

// DESIGN.md: "Fenced code uses the mono face on a subtly darker fill,
// scrolls horizontally rather than wrapping, and is long-press copyable."
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CodeBlockView(code: String) {
    val colors = LocalOpenAGIColors.current
    val clipboard = LocalClipboardManager.current
    Surface(color = colors.edge, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .combinedClickable(onClick = {}, onLongClick = { clipboard.setText(AnnotatedString(code)) })
                .padding(10.dp),
        ) {
            Text(code, style = OpenAGIType.dataMono, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}
