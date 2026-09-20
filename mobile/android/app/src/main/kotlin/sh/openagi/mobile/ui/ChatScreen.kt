package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.ChatDeltaPayload
import sh.openagi.mobile.protocol.ChatFailurePayload
import sh.openagi.mobile.protocol.ChatFinalPayload
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.SseFrame
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType

// FEATURES.md's "Chat": "the one that makes the phone genuinely useful away
// from the desk." Sends over POST /message with Accept: text/event-stream —
// the daemon's real streaming mechanism (see DaemonClient.sendMessageStream's
// own comment) — and renders tokens as they arrive rather than waiting for
// the whole answer. The connection line's dot doubles as the stream
// indicator: filled while a reply is actively streaming.
private sealed class ChatEntry {
    data class User(val text: String) : ChatEntry()
    data class Assistant(val text: String, val streaming: Boolean, val failed: Boolean = false) : ChatEntry()
}

@Composable
fun ChatScreen(context: Context, credentials: Credentials) {
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    var messages by remember { mutableStateOf(listOf<ChatEntry>()) }
    var inputText by remember { mutableStateOf("") }
    var isStreaming by remember { mutableStateOf(false) }
    var everConnected by remember { mutableStateOf(false) }

    fun updateLastAssistant(text: String, streaming: Boolean, failed: Boolean = false) {
        messages = messages.toMutableList().also { list ->
            val index = list.indexOfLast { it is ChatEntry.Assistant }
            if (index >= 0) list[index] = ChatEntry.Assistant(text, streaming, failed)
        }
    }

    fun decodeFrame(frame: SseFrame) {
        when (frame.event) {
            "delta" -> {
                val payload = runCatching { ProtocolJson.json.decodeFromString(ChatDeltaPayload.serializer(), frame.data) }.getOrNull()
                if (payload != null) {
                    val current = (messages.lastOrNull { it is ChatEntry.Assistant } as? ChatEntry.Assistant)?.text ?: ""
                    val next = if (payload.reset) payload.text else current + payload.text
                    updateLastAssistant(next, streaming = true)
                }
            }
            "final" -> {
                val payload = runCatching { ProtocolJson.json.decodeFromString(ChatFinalPayload.serializer(), frame.data) }.getOrNull()
                val current = (messages.lastOrNull { it is ChatEntry.Assistant } as? ChatEntry.Assistant)?.text ?: ""
                val text = payload?.reply?.takeIf { it.isNotBlank() } ?: current
                updateLastAssistant(text.ifBlank { "(no reply)" }, streaming = false)
            }
            "failure" -> {
                val payload = runCatching { ProtocolJson.json.decodeFromString(ChatFailurePayload.serializer(), frame.data) }.getOrNull()
                updateLastAssistant(
                    payload?.error?.takeIf { it.isNotBlank() } ?: "OpenAGI couldn't reply. Try again.",
                    streaming = false,
                    failed = true,
                )
            }
            else -> Unit // status/session/hello/heartbeat: no visible change needed
        }
    }

    fun send() {
        val text = inputText.trim()
        if (text.isEmpty() || isStreaming) return
        inputText = ""
        messages = messages + ChatEntry.User(text) + ChatEntry.Assistant("", streaming = true)
        scope.launch {
            isStreaming = true
            try {
                client.sendMessageStream(text).collect { frame ->
                    everConnected = true
                    decodeFrame(frame)
                }
            } catch (error: Exception) {
                updateLastAssistant(
                    "Can't reach OpenAGI. Nothing is listening at ${credentials.server}. Is the daemon running?",
                    streaming = false,
                    failed = true,
                )
            } finally {
                isStreaming = false
            }
        }
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "Chat",
            connection = when {
                isStreaming -> ConnectionState.Synced(credentials.server, 0)
                everConnected -> ConnectionState.Synced(credentials.server, 0)
                else -> ConnectionState.NeverSynced(credentials.server)
            },
        )

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(messages) { entry -> ChatBubble(entry) }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = inputText,
                onValueChange = { inputText = it },
                placeholder = { Text("Message OpenAGI") },
                modifier = Modifier.weight(1f),
            )
            PrimaryButton(text = "Send", enabled = inputText.isNotBlank() && !isStreaming, onClick = { send() }, modifier = Modifier.weight(0.32f))
        }
    }
}

@Composable
private fun ChatBubble(entry: ChatEntry) {
    val colors = LocalOpenAGIColors.current
    when (entry) {
        is ChatEntry.User -> {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Text(entry.text, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onBackground)
            }
        }
        is ChatEntry.Assistant -> {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text("OpenAGI", style = OpenAGIType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    entry.text.ifBlank { "…" },
                    style = OpenAGIType.body,
                    color = if (entry.failed) colors.alert else MaterialTheme.colorScheme.onBackground,
                )
            }
        }
    }
}
