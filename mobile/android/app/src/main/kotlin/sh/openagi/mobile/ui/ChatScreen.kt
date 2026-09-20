@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.ChatDeltaPayload
import sh.openagi.mobile.protocol.ChatFailurePayload
import sh.openagi.mobile.protocol.ChatFinalPayload
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SseFrame
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.markdown.InlineSpan
import sh.openagi.mobile.ui.markdown.Markdown
import sh.openagi.mobile.ui.markdown.MarkdownBlock
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy

// DESIGN.md's Chat section: "A conversation, not a transcript." Alignment
// carries the speaker — no "You"/"OpenAGI" labels at all — with bubbles,
// grouped spacing, Markdown rendering, a resting typing indicator before the
// first token, and a composer that never hides behind the keyboard. Sends
// over POST /message with Accept: text/event-stream and renders frames as
// they arrive; see DaemonClient.sendMessageStream's own comment for why that
// isn't GET /events.
private sealed interface ChatEntry {
    val id: Long
    val timestamp: Instant

    data class User(override val id: Long, override val timestamp: Instant, val text: String) : ChatEntry

    data class Assistant(
        override val id: Long,
        override val timestamp: Instant,
        val text: String,
        val streaming: Boolean,
        val failed: Boolean = false,
        val failureDetail: String? = null,
        // The exact text that produced this reply, kept so "Try again" can
        // resend it without the user retyping — never sent back to the
        // daemon as anything but a fresh POST /message body.
        val retryText: String? = null,
    ) : ChatEntry
}

@Composable
fun ChatScreen(context: Context, credentials: Credentials) {
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val clipboard = LocalClipboardManager.current

    var messages by remember { mutableStateOf(listOf<ChatEntry>()) }
    var inputText by remember { mutableStateOf("") }
    var isStreaming by remember { mutableStateOf(false) }
    var nextId by remember { mutableStateOf(0L) }

    // DESIGN.md: "the list stays pinned to the bottom while the user has not
    // scrolled away; if they have scrolled up, do not yank them back." Once
    // there is nothing left to scroll forward to, the user is at the bottom.
    val stickToBottom by remember { derivedStateOf { !listState.canScrollForward } }

    fun newId(): Long { val id = nextId; nextId += 1; return id }

    fun updateAssistant(id: Long, transform: (ChatEntry.Assistant) -> ChatEntry.Assistant) {
        messages = messages.map { entry -> if (entry is ChatEntry.Assistant && entry.id == id) transform(entry) else entry }
    }

    fun applyFailure(id: Long, message: ErrorCopy.Message) {
        updateAssistant(id) { current ->
            current.copy(text = message.headline, failureDetail = message.detail, streaming = false, failed = true)
        }
    }

    fun decodeFrame(assistantId: Long, frame: SseFrame) {
        when (frame.event) {
            "delta" -> {
                val payload = runCatching { ProtocolJson.json.decodeFromString(ChatDeltaPayload.serializer(), frame.data) }.getOrNull()
                if (payload != null) {
                    updateAssistant(assistantId) { current ->
                        val next = if (payload.reset) payload.text else current.text + payload.text
                        current.copy(text = next, streaming = true, failed = false, failureDetail = null)
                    }
                }
            }
            "final" -> {
                val payload = runCatching { ProtocolJson.json.decodeFromString(ChatFinalPayload.serializer(), frame.data) }.getOrNull()
                updateAssistant(assistantId) { current ->
                    val text = payload?.reply?.takeIf { it.isNotBlank() } ?: current.text
                    current.copy(text = text.ifBlank { "(no reply)" }, streaming = false, failed = false, failureDetail = null)
                }
            }
            "failure" -> {
                val payload = runCatching { ProtocolJson.json.decodeFromString(ChatFailurePayload.serializer(), frame.data) }.getOrNull()
                applyFailure(
                    assistantId,
                    ErrorCopy.Message(payload?.error?.takeIf { it.isNotBlank() } ?: "OpenAGI couldn't reply.", "Try again."),
                )
            }
            // status/session: progress-only, nothing visible changes. heartbeat:
            // PROTOCOL.md's every-15s keepalive during a long turn — it must
            // never be mistaken for an empty reply. Anything else is a frame
            // name this client doesn't know yet and is ignored the same way.
            "status", "session", "heartbeat" -> Unit
            else -> Unit
        }
    }

    suspend fun runExchange(assistantId: Long, text: String) {
        isStreaming = true
        try {
            client.sendMessageStream(text).collect { frame -> decodeFrame(assistantId, frame) }
        } catch (error: DaemonException) {
            applyFailure(assistantId, chatErrorCopy(error, credentials.server))
        } catch (error: Exception) {
            applyFailure(
                assistantId,
                ErrorCopy.Message("Can't reach OpenAGI.", "Nothing is listening at ${credentials.server}. Is the daemon running?"),
            )
        } finally {
            isStreaming = false
        }
    }

    fun send() {
        val text = inputText.trim()
        if (text.isEmpty() || isStreaming) return
        inputText = ""
        val userId = newId()
        val assistantId = newId()
        val now = Instant.now()
        messages = messages + ChatEntry.User(userId, now, text) +
            ChatEntry.Assistant(assistantId, now, "", streaming = true, retryText = text)
        scope.launch { runExchange(assistantId, text) }
    }

    fun retry(entry: ChatEntry.Assistant) {
        val text = entry.retryText
        if (text == null || isStreaming) return
        messages = messages.map { current ->
            if (current is ChatEntry.Assistant && current.id == entry.id) {
                current.copy(text = "", streaming = true, failed = false, failureDetail = null)
            } else {
                current
            }
        }
        scope.launch { runExchange(entry.id, text) }
    }

    LaunchedEffect(messages) {
        if (messages.isNotEmpty() && stickToBottom) {
            listState.scrollToItem(messages.lastIndex)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "Chat",
            connection = if (isStreaming) ConnectionState.Live(credentials.server) else ConnectionState.Reconnecting(credentials.server),
        )

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
            ) {
                itemsIndexed(messages, key = { _, entry -> entry.id }) { index, entry ->
                    val previous = messages.getOrNull(index - 1)
                    val showDivider = MessageGrouping.needsTimestampDivider(previous?.timestamp?.epochSecond, entry.timestamp.epochSecond)
                    val topSpacing = MessageGrouping.spacingBeforeDp(
                        previousIsUser = previous?.let { it is ChatEntry.User },
                        previousEpochSeconds = previous?.timestamp?.epochSecond,
                        currentIsUser = entry is ChatEntry.User,
                        currentEpochSeconds = entry.timestamp.epochSecond,
                    )
                    Column(modifier = Modifier.fillMaxWidth().padding(top = topSpacing.dp)) {
                        if (showDivider) {
                            Text(
                                formatDividerTime(entry.timestamp),
                                style = OpenAGIType.caption,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                            )
                        }
                        ChatBubble(entry, clipboard = clipboard, onRetry = { failed -> retry(failed) })
                    }
                }
            }

            if (!stickToBottom && messages.isNotEmpty()) {
                JumpToLatestPill(
                    onClick = { scope.launch { listState.scrollToItem(messages.lastIndex) } },
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                )
            }
        }

        Composer(
            value = inputText,
            onValueChange = { inputText = it },
            enabled = inputText.isNotBlank() && !isStreaming,
            onSend = { send() },
        )
    }
}

// DaemonException.Server(503) on /message is exactly and only
// src/hosted-interface.js's `{ error: "agent-host-disabled" }` — no agent
// host configured on the daemon, which a bare test daemon hits by design.
// Every other DaemonException already has a legible daemon-wide phrasing in
// ErrorCopy; this is chat's one addition.
private fun chatErrorCopy(error: DaemonException, host: String): ErrorCopy.Message =
    if (error is DaemonException.Server && error.code == 503) {
        ErrorCopy.Message(
            "OpenAGI can't chat yet.",
            "No agent host is configured on this daemon. Set one up, then try again.",
        )
    } else {
        ErrorCopy.forDaemon(error, host)
    }

private fun formatDividerTime(instant: Instant): String =
    DateTimeFormatter.ofPattern("h:mm a").withZone(ZoneId.systemDefault()).format(instant)

@Composable
private fun ChatBubble(entry: ChatEntry, clipboard: androidx.compose.ui.platform.ClipboardManager, onRetry: (ChatEntry.Assistant) -> Unit) {
    val colors = LocalOpenAGIColors.current
    when (entry) {
        is ChatEntry.User -> {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Surface(
                    color = colors.live.copy(alpha = 0.12f),
                    shape = bubbleShape(isUser = true),
                    modifier = Modifier.fillMaxWidth(0.78f),
                ) {
                    Text(
                        entry.text,
                        style = OpenAGIType.body,
                        color = MaterialTheme.colorScheme.onBackground,
                        modifier = Modifier
                            .combinedClickable(onClick = {}, onLongClick = { clipboard.setText(AnnotatedString(entry.text)) })
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }
        }
        is ChatEntry.Assistant -> {
            Column(modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                    Surface(
                        color = MaterialTheme.colorScheme.surface,
                        shape = bubbleShape(isUser = false),
                        modifier = Modifier.fillMaxWidth(0.85f),
                    ) {
                        Box(
                            modifier = Modifier
                                .combinedClickable(
                                    onClick = {},
                                    onLongClick = { if (entry.text.isNotBlank()) clipboard.setText(AnnotatedString(entry.text)) },
                                )
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                        ) {
                            if (entry.streaming && entry.text.isBlank()) {
                                TypingDots()
                            } else {
                                val textColor = if (entry.failed) colors.alert else MaterialTheme.colorScheme.onBackground
                                MarkdownBlocksView(Markdown.parse(entry.text), textColor = textColor)
                            }
                        }
                    }
                }
                if (entry.failed) {
                    Column(modifier = Modifier.padding(top = 4.dp)) {
                        entry.failureDetail?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = OpenAGIType.caption, color = colors.alert)
                        }
                        Text(
                            "Try again",
                            style = OpenAGIType.secondary,
                            color = colors.alert,
                            modifier = Modifier.clickable { onRetry(entry) }.padding(top = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun bubbleShape(isUser: Boolean) = RoundedCornerShape(
    topStart = 18.dp,
    topEnd = 18.dp,
    // "Bottom-trailing corner at 4" for a sent message, "bottom-leading
    // corner at 4" for a received one — trailing/leading, not left/right, so
    // this still reads correctly in an RTL layout (supportsRtl is set).
    bottomStart = if (isUser) 18.dp else 4.dp,
    bottomEnd = if (isUser) 4.dp else 18.dp,
)

@Composable
private fun TypingDots() {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(3) {
            Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(muted))
        }
    }
}

@Composable
private fun MarkdownBlocksView(blocks: List<MarkdownBlock>, textColor: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MarkdownBlock.Paragraph -> Text(renderInline(block.spans, textColor), style = OpenAGIType.body, color = textColor)
                is MarkdownBlock.Bullet -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("•", style = OpenAGIType.body, color = textColor)
                    Text(renderInline(block.spans, textColor), style = OpenAGIType.body, color = textColor, modifier = Modifier.weight(1f))
                }
                is MarkdownBlock.Numbered -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${block.index}.", style = OpenAGIType.body, color = textColor)
                    Text(renderInline(block.spans, textColor), style = OpenAGIType.body, color = textColor, modifier = Modifier.weight(1f))
                }
                is MarkdownBlock.CodeBlock -> CodeBlockView(block.code)
            }
        }
    }
}

private fun renderInline(spans: List<InlineSpan>, base: Color): AnnotatedString = buildAnnotatedString {
    spans.forEach { span ->
        when (span) {
            is InlineSpan.Text -> append(span.text)
            is InlineSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
            is InlineSpan.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(span.text) }
            is InlineSpan.Link -> withStyle(SpanStyle(color = base, textDecoration = TextDecoration.Underline)) { append(span.text) }
        }
    }
}

// DESIGN.md: "Fenced code uses the mono face on a subtly darker fill,
// scrolls horizontally rather than wrapping, and is long-press copyable."
@Composable
private fun CodeBlockView(code: String) {
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

@Composable
private fun JumpToLatestPill(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalOpenAGIColors.current
    Surface(
        color = colors.live,
        shape = RoundedCornerShape(50),
        modifier = modifier.clip(RoundedCornerShape(50)).clickable(onClick = onClick),
    ) {
        Text(
            "Jump to latest",
            style = OpenAGIType.secondary,
            color = Color.White,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun Composer(value: String, onValueChange: (String) -> Unit, enabled: Boolean, onSend: () -> Unit) {
    val colors = LocalOpenAGIColors.current
    Column(modifier = Modifier.fillMaxWidth().imePadding().navigationBarsPadding()) {
        HorizontalDivider(color = colors.edge, thickness = 1.dp)
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = { Text("Message OpenAGI") },
                maxLines = 5,
                modifier = Modifier.weight(1f),
            )
            SendButton(enabled = enabled, onClick = onSend)
        }
    }
}

// DESIGN.md: "Send is disabled and `muted` until there is non-whitespace
// text." A small dedicated control rather than the shared full-width
// PrimaryButton, whose disabled state is a faded `live`, not `muted`.
@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Box(
        modifier = Modifier
            .height(44.dp)
            .widthIn(min = 64.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (enabled) colors.live else Color.Transparent)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text("Send", style = OpenAGIType.body, color = if (enabled) Color.White else muted)
    }
}
