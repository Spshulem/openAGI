@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)

package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.ConversationPage
import sh.openagi.mobile.protocol.ChatDeltaPayload
import sh.openagi.mobile.protocol.ChatFailurePayload
import sh.openagi.mobile.protocol.ChatFinalPayload
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.store.ChatHistoryStore
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.SavedChatEntry
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SseFrame
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.FoldAwareChatColumn
import sh.openagi.mobile.ui.components.ChatTopBar
import sh.openagi.mobile.ui.components.DownArrowGlyph
import sh.openagi.mobile.ui.components.SendArrowGlyph
import sh.openagi.mobile.ui.markdown.MarkdownView
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
internal sealed interface ChatEntry {
    val id: Long
    val timestamp: Instant
    // The daemon's message id once this line is confirmed in the shared thread.
    val serverId: String?

    data class User(
        override val id: Long,
        override val timestamp: Instant,
        val text: String,
        override val serverId: String? = null,
        // Set only when another paired device (a G2, another phone) sent it.
        val sourceName: String? = null,
    ) : ChatEntry

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
        // What the agent is doing right now ("Using fleet_status"), from the
        // stream's status frames. Shown only while streaming; never saved.
        val activity: String? = null,
        override val serverId: String? = null,
    ) : ChatEntry
}

// Plain words for a status frame: the tool it is running, else its stage.
internal fun chatActivityLabel(data: String): String? {
    val obj = runCatching { ProtocolJson.json.parseToJsonElement(data) as? kotlinx.serialization.json.JsonObject }.getOrNull() ?: return null
    fun field(name: String) = (obj[name] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() }
    val tool = field("tool")
    if (tool != null) return "Using ${tool.replace('_', ' ')}"
    return when (field("stage")) {
        null -> null
        "routing" -> "Getting started"
        "thinking" -> "Thinking"
        "saving" -> "Saving"
        else -> field("stage")!!.replace('-', ' ').replaceFirstChar { it.uppercase() }
    }
}

// Kept by the Activity so switching tabs does not discard a conversation
// while the daemon keeps the same session alive. Replies stream in `scope`,
// the Activity's, so leaving the tab mid-reply does not cancel the stream and
// leave a false "Can't reach OpenAGI" in the kept history.
//
// With a thread ("agent" or "supervisor"), the conversation is the daemon's
// shared thread that every paired device talks in: it is loaded from the
// daemon when the screen opens, after each reply, and whenever /events says
// the thread changed (PROTOCOL.md §3.1).
//
// With a store, the conversation is also cached on the phone, so folding the
// phone (which recreates the Activity), a process kill, a relaunch, or being
// offline keeps it. A reply that was still streaming when the app died comes
// back as stopped, with "Try again".
//
// An older daemon answers 400 to a /message body with `thread`. The send is
// then made again without it, keyed as before shared threads (legacySessionKey
// as both sessionId and from, which keeps the Supervisor apart from Chat), and
// `threadSupport`, shared by both conversations of one pairing, remembers it
// until the app restarts or pairs again.
class ChatConversationState(
    internal val scope: CoroutineScope,
    private val store: ChatHistoryStore? = null,
    private val nodeId: String = "",
    private val io: CoroutineDispatcher = Dispatchers.IO,
    internal val thread: String? = null,
    private val legacySessionKey: String? = null,
    internal val threadSupport: SharedThreadSupport = SharedThreadSupport(),
    // The composer draft. The Activity passes a saveable one, so the draft
    // also survives Android recreating the Activity.
    draft: MutableState<String> = mutableStateOf(""),
) {
    internal val messages = mutableStateOf<List<ChatEntry>>(emptyList())
    internal val inputText = draft
    internal val isStreaming = mutableStateOf(false)
    internal val nextId = mutableStateOf(0L)
    // False until the daemon says there is nothing older than what is shown.
    internal val olderExhausted = mutableStateOf(false)
    internal val loadingOlder = mutableStateOf(false)
    // Waits between retries of a failed history load. A reconnected /events
    // stream also asks for a refresh, so recovery never depends on these alone.
    internal var refreshRetryDelaysMs = listOf(2_000L, 5_000L, 15_000L)

    internal val sharedThread: String? get() = thread?.takeIf { threadSupport.supported }

    init {
        val restored = store?.load(nodeId).orEmpty().map { it.toEntry() }
        if (restored.isNotEmpty()) {
            messages.value = restored
            nextId.value = restored.maxOf { it.id } + 1
        }
    }

    private var refreshJob: Job? = null
    private var refreshAgain = false

    // Loads the thread's newest page and folds it in. Calls that arrive while
    // one is running collapse into one more run, so a burst of events costs
    // at most two fetches. A failure keeps the cached conversation as it is
    // and is retried a few times with backoff.
    fun requestRefresh(client: DaemonClient) = requestRefresh { name, before -> client.conversationMessages(name, before) }

    internal fun requestRefresh(fetch: suspend (thread: String, before: String?) -> ConversationPage) {
        val name = sharedThread ?: return
        if (refreshJob?.isActive == true) {
            refreshAgain = true
            return
        }
        refreshJob = scope.launch {
            do {
                refreshAgain = false
                var page: ConversationPage? = null
                for (attempt in 0..refreshRetryDelaysMs.size) {
                    if (attempt > 0) delay(refreshRetryDelaysMs[attempt - 1])
                    try {
                        page = fetch(name, null)
                        break
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (missing: DaemonException.NotFound) {
                        break
                    } catch (error: Exception) {
                        if (refreshAgain) break
                    }
                }
                if (page == null) continue
                var id = nextId.value
                messages.value = ChatHistoryMerge.merge(messages.value, page, nodeId) { id++ }
                nextId.value = id
                // When the page is the oldest line shown, it alone says whether
                // anything older exists; older lines kept above it keep theirs.
                if (messages.value.firstOrNull { it.serverId != null }?.serverId == page.messages.firstOrNull()?.id) {
                    olderExhausted.value = page.nextBefore == null
                }
                persist()
            } while (refreshAgain)
        }
    }

    private var olderJob: Job? = null

    // Loads the page just before the oldest line shown ("Load earlier
    // messages") and puts it on top.
    fun loadOlder(client: DaemonClient) = loadOlder { name, before -> client.conversationMessages(name, before) }

    internal fun loadOlder(fetch: suspend (thread: String, before: String?) -> ConversationPage) {
        val name = sharedThread ?: return
        if (olderJob?.isActive == true || olderExhausted.value) return
        val before = messages.value.firstOrNull { it.serverId != null }?.serverId ?: return
        loadingOlder.value = true
        olderJob = scope.launch {
            try {
                val page = try {
                    fetch(name, before)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (missing: DaemonException.NotFound) {
                    olderExhausted.value = true
                    null
                } catch (error: Exception) {
                    null
                } ?: return@launch
                var id = nextId.value
                messages.value = ChatHistoryMerge.prependOlder(messages.value, page, nodeId) { id++ }
                nextId.value = id
                if (page.nextBefore == null) olderExhausted.value = true
                persist()
            } finally {
                loadingOlder.value = false
            }
        }
    }

    // The reply stream for one send: the shared thread when the daemon has
    // them, else the pre-thread keying. A 400 before any frame is the older
    // daemon refusing the `thread` field, so nothing was processed and the
    // send is made once more without it.
    internal fun messageStream(
        text: String,
        from: String?,
        sessionId: String?,
        send: (text: String, from: String?, sessionId: String?, thread: String?) -> Flow<SseFrame>,
    ): Flow<SseFrame> = flow {
        val name = sharedThread
        if (name == null) {
            emitAll(send(text, legacySessionKey ?: from, legacySessionKey ?: sessionId, null))
            return@flow
        }
        var received = false
        try {
            send(text, from, sessionId, name).collect { frame ->
                received = true
                emit(frame)
            }
            return@flow
        } catch (error: DaemonException.Server) {
            if (error.code != 400 || received) throw error
        }
        var confirmed = false
        send(text, legacySessionKey ?: from, legacySessionKey ?: sessionId, null).collect { frame ->
            if (!confirmed) {
                confirmed = true
                threadSupport.supported = false
            }
            emit(frame)
        }
    }

    // Called after every change that should outlive the screen: a send, a
    // finished or failed reply, a retry, a refresh.
    internal fun persist() {
        val entries = messages.value.mapNotNull { it.toSaved() }
        val target = store ?: return
        // Numbered now, on the caller's thread, so a write that reaches the
        // file late never replaces a newer snapshot.
        val sequence = ChatHistoryStore.nextSequence()
        // A scope already cancelled (the Activity went away mid-reply) still
        // gets its last write, on this thread; the file is small.
        if (scope.isActive) scope.launch(io) { target.save(nodeId, entries, sequence) } else target.save(nodeId, entries, sequence)
    }
}

// Whether this pairing's daemon takes the shared-thread `thread` field. One
// per pairing, shared by Chat and the Supervisor; reset by restart or pairing.
class SharedThreadSupport {
    @Volatile var supported: Boolean = true
}

private fun ChatEntry.toSaved(): SavedChatEntry? = when (this) {
    is ChatEntry.User -> SavedChatEntry(id, "user", timestamp, text, serverId = serverId, sourceName = sourceName)
    // A still-streaming reply is saved as stopped: if the app dies now, the
    // next launch must not show a reply that will never finish.
    is ChatEntry.Assistant -> SavedChatEntry(
        id, "assistant", timestamp, text,
        failed = failed || streaming,
        failureDetail = if (streaming && !failed) "Reply stopped when the app closed." else failureDetail,
        retryText = retryText,
        serverId = serverId,
    )
}

private fun SavedChatEntry.toEntry(): ChatEntry = if (role == "user") {
    ChatEntry.User(id, at, text, serverId = serverId, sourceName = sourceName)
} else {
    ChatEntry.Assistant(id, at, text, streaming = false, failed = failed, failureDetail = failureDetail, retryText = retryText, serverId = serverId)
}

// The Supervisor's "Ask supervisor" reuses this whole screen: the same
// bubbles and transport, its own title, its own conversation, and a few
// starter questions while it is empty. Each sends its conversation state's
// thread ("agent" for Chat, "supervisor" for the Supervisor), which the
// daemon keys on; with no thread, a phone credential's conversation is keyed
// on `from` instead (bindScopedNodeMessage).
@Composable
fun ChatScreen(
    context: Context,
    credentials: Credentials,
    streamAttached: Boolean,
    title: String = "Chat",
    sessionId: String? = null,
    from: String? = null,
    starters: List<String> = emptyList(),
    conversationState: ChatConversationState,
    onBack: (() -> Unit)? = null,
    onComposerFocusChanged: (Boolean) -> Unit = {},
) {
    val client = remember(credentials) { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    var showingHistory by remember { mutableStateOf(false) }
    var historyQuery by remember { mutableStateOf("") }
    var showingFallback by remember { mutableStateOf(false) }
    if (showingFallback) sh.openagi.mobile.fallback.FallbackChatScreen(context, localAgentMode = credentials.isEmbedded) { showingFallback = false }
    val scope = rememberCoroutineScope()
    // Starts at the newest line (an index past the end is clamped to the
    // last item), so a reopened chat never flashes its oldest messages
    // before the scroll to the end below.
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = conversationState.messages.value.size)
    val clipboard = LocalClipboardManager.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    var messages by conversationState.messages
    var inputText by conversationState.inputText
    var isStreaming by conversationState.isStreaming
    var nextId by conversationState.nextId

    if (showingHistory) {
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { showingHistory = false }) {
            Column(Modifier.fillMaxWidth().padding(24.dp)) {
                Text("Conversation history", style = MaterialTheme.typography.headlineSmall)
                androidx.compose.material3.OutlinedTextField(value = historyQuery, onValueChange = { historyQuery = it },
                    label = { Text("Search saved messages") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
                    itemsIndexed(messages.filter { entry ->
                        val text = when (entry) { is ChatEntry.User -> entry.text; is ChatEntry.Assistant -> entry.text }
                        historyQuery.isBlank() || text.contains(historyQuery, ignoreCase = true)
                    }) { _, entry ->
                        androidx.compose.material3.ListItem(
                            headlineContent = { Text(when (entry) { is ChatEntry.User -> entry.text; is ChatEntry.Assistant -> entry.text }, maxLines = 3) },
                            supportingContent = { Text(if (entry is ChatEntry.User) "You" else "OpenAGI") },
                            modifier = Modifier.clickable {
                                val index = messages.indexOfFirst { it.id == entry.id }
                                showingHistory = false
                                if (index >= 0) scope.launch { listState.scrollToItem(index) }
                            })
                    }
                }
            }
        }
    }

    // DESIGN.md: "the list stays pinned to the bottom while the user has not
    // scrolled away; if they have scrolled up, do not yank them back." Only
    // the person's own drags and flings decide that (see ChatScroll); the
    // list merely having more below it, as it does on first open or while a
    // reply grows, never counts as scrolling away.
    var userScrolledAway by remember { mutableStateOf(false) }
    val userScroll = remember {
        object : NestedScrollConnection {
            // Programmatic scrolls (following, Jump to latest) bypass nested
            // scroll, so everything seen here is a drag or its fling.
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                userScrolledAway = ChatScroll.scrolledAwayAfterUserScroll(userScrolledAway, consumed.y, listState.canScrollForward)
                return Offset.Zero
            }
        }
    }
    // Each scroll runs in its own coroutine: a newer scroll, or the person's
    // touch, cancels the running one, and must not cancel the loop below.
    fun followToEnd() {
        scope.launch { listState.scrollToEnd() }
    }

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
            "status" -> {
                val label = chatActivityLabel(frame.data)
                if (label != null) updateAssistant(assistantId) { current -> if (current.streaming) current.copy(activity = label) else current }
            }
            "session", "heartbeat" -> Unit
            else -> Unit
        }
    }

    suspend fun runExchange(assistantId: Long, text: String) {
        isStreaming = true
        try {
            var receivedTerminal = false
            conversationState.messageStream(text, from, sessionId) { t, f, s, th -> client.sendMessageStream(t, from = f, sessionId = s, thread = th) }.collect { frame ->
                if (frame.event == "final" || frame.event == "failure") receivedTerminal = true
                decodeFrame(assistantId, frame)
            }
            if (!receivedTerminal) {
                applyFailure(assistantId, ErrorCopy.Message("Reply stopped early.", "Try again."))
            }
        } catch (error: DaemonException) {
            applyFailure(assistantId, chatErrorCopy(error, credentials.server))
        } catch (error: Exception) {
            applyFailure(
                assistantId,
                ErrorCopy.Message("Can't reach OpenAGI.", "Nothing is listening at ${credentials.server}. Is the daemon running?"),
            )
        } finally {
            isStreaming = false
            conversationState.persist()
            // The daemon's copy of this exchange replaces the local one.
            conversationState.requestRefresh(client)
        }
    }

    fun start(text: String) {
        if (text.isEmpty() || isStreaming) return
        // Sending is a request to see the answer.
        userScrolledAway = false
        val userId = newId()
        val assistantId = newId()
        val now = Instant.now()
        messages = messages + ChatEntry.User(userId, now, text) +
            ChatEntry.Assistant(assistantId, now, "", streaming = true, retryText = text)
        conversationState.persist()
        conversationState.scope.launch { runExchange(assistantId, text) }
    }

    fun send() {
        val text = inputText.trim()
        if (text.isEmpty() || isStreaming) return
        inputText = ""
        start(text)
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
        conversationState.scope.launch { runExchange(entry.id, text) }
    }

    // Opening the screen shows the shared thread as the daemon has it,
    // including what other devices said while this one was away.
    LaunchedEffect(conversationState) {
        conversationState.requestRefresh(client)
    }

    // "Load earlier messages" sits above the oldest line while the shared
    // thread may have more (PROTOCOL.md §3.1's before cursor).
    val olderExhausted by conversationState.olderExhausted
    val loadingOlder by conversationState.loadingOlder
    val showLoadOlder = conversationState.sharedThread != null && !olderExhausted && messages.any { it.serverId != null }

    // Opening a chat, or coming back to one, shows the newest message: once
    // the list has laid out anything, go to the very end. After that, keep
    // the end in view whenever there is more below it (a reply streaming in,
    // a refresh, the keyboard taking height) while the person has not
    // scrolled away and is not touching the list.
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > 0 }
        followToEnd()
        snapshotFlow { listState.canScrollForward && !listState.isScrollInProgress && !userScrolledAway }
            .collect { behind -> if (behind) followToEnd() }
    }

    val showJump = userScrolledAway && listState.canScrollForward && messages.isNotEmpty()

    // On a wide window (an unfolded Fold, a tablet) the messages and the
    // composer keep one readable column, centred, while the whole width
    // still scrolls.
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val gutter = chatGutter(maxWidth)
        FoldAwareChatColumn(messages = {
            Column(modifier = Modifier.fillMaxSize()) {
                ChatTopBar(
                    title = title,
                    connection = if (streamAttached || isStreaming) ConnectionState.Live(credentials.server) else ConnectionState.Reconnecting(credentials.server),
                    onBack = onBack,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    androidx.compose.material3.TextButton(onClick = { showingHistory = true }) { Text("History") }
                    if (credentials.isEmbedded) androidx.compose.material3.TextButton(onClick = { showingFallback = true }) { Text("Gemini Nano · On this phone") }
                    else Text("Connected agent", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(12.dp))
                }
                if (!credentials.isEmbedded && (title == "Chat" || !streamAttached)) {
                    androidx.compose.material3.TextButton(onClick = { showingFallback = true }, enabled = !isStreaming) {
                        Text(if (streamAttached) "Chat without server" else "Server reconnecting · Use local or hosted chat")
                    }
                }

                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    LazyColumn(
                        state = listState,
                        // Room under the last line for the jump button while it shows,
                        // so it never sits on the end of a reply.
                        contentPadding = PaddingValues(start = gutter, end = gutter, top = 4.dp, bottom = if (showJump) 12.dp + JUMP_BUTTON_SPACE else 12.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .nestedScroll(userScroll)
                            // Touching the conversation, to scroll or to tap, puts the
                            // keyboard away so there is room to read. Observed on the
                            // initial pass and never consumed, so scrolling, links,
                            // long-press copy and "Try again" all still work.
                            .pointerInput(Unit) {
                                awaitEachGesture {
                                    awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                    focusManager.clearFocus()
                                    keyboard?.hide()
                                }
                            },
                    ) {
                        if (showLoadOlder) {
                            item(key = "load-older") {
                                Text(
                                    if (loadingOlder) "Loading earlier messages…" else "Load earlier messages",
                                    style = OpenAGIType.caption,
                                    color = MaterialTheme.colorScheme.primary,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable(enabled = !loadingOlder) {
                                            // Reading back: stay with the older lines.
                                            userScrolledAway = true
                                            conversationState.loadOlder(client)
                                        }
                                        .padding(vertical = 12.dp),
                                )
                            }
                        }
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

                    if (messages.isEmpty()) {
                        Column(Modifier.align(Alignment.Center).padding(gutter), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text("What would you like to do?", style = MaterialTheme.typography.headlineLarge)
                            Text(if (credentials.isEmbedded) "Your agent, tasks and conversations live on this phone." else "Plan your day, keep track of work, or ask your agent for help.",
                                style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            StarterChips(starters = starters.ifEmpty { listOf("Help me plan my day", "Show my tasks", "Remember something for me") },
                                onPick = { inputText = it })
                        }
                    }

                    if (showJump) {
                        JumpToLatestButton(
                            onClick = {
                                userScrolledAway = false
                                followToEnd()
                            },
                            modifier = Modifier.align(Alignment.BottomEnd).padding(end = gutter, bottom = 12.dp),
                        )
                    }
                }

            }
        }, composer = {
            Composer(
                value = inputText,
                onValueChange = { inputText = it },
                enabled = inputText.isNotBlank() && !isStreaming,
                onSend = { send() },
                gutter = gutter,
                onFocus = onComposerFocusChanged,
            )
        })
    }
}

// Where a chat list scrolls to: the very end of its last item, not that
// item's top edge, so a reply taller than the screen shows its newest lines.
// The list clamps the oversized scroll at its true end.
internal suspend fun LazyListState.scrollToEnd() {
    val last = layoutInfo.totalItemsCount - 1
    if (last < 0) return
    scrollToItem(last)
    scrollBy(ChatScroll.PAST_THE_END_PX)
}

// The rule for "has the person scrolled away from the latest", fed only by
// their own drags and flings. Pure, so it is unit-tested.
internal object ChatScroll {
    // Far larger than any reply; the list stops at its real end.
    const val PAST_THE_END_PX = 1_000_000f

    // deltaY is what the list just moved under the finger: positive toward
    // older messages. Reaching the end again resumes following; moving back
    // from it means reading, and stays that way until the end is reached.
    fun scrolledAwayAfterUserScroll(wasAway: Boolean, deltaY: Float, canScrollForward: Boolean): Boolean = when {
        !canScrollForward -> false
        deltaY > 0f -> true
        else -> wasAway
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

// Replies read like a page: full width, no bubble, so a long answer fits as
// much text per line as the screen allows. The owner's own messages stay as
// compact bubbles on the trailing side, which is what still carries the
// speaker without labels.
@Composable
private fun ChatBubble(entry: ChatEntry, clipboard: androidx.compose.ui.platform.ClipboardManager, onRetry: (ChatEntry.Assistant) -> Unit) {
    val colors = LocalOpenAGIColors.current
    when (entry) {
        is ChatEntry.User -> {
            entry.sourceName?.let { source ->
                Text(
                    "From $source",
                    style = OpenAGIType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp),
                )
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                // At most 85% of the width, and only as wide as the text.
                Box(modifier = Modifier.fillMaxWidth(0.85f), contentAlignment = Alignment.CenterEnd) {
                    Surface(
                        color = colors.live.copy(alpha = 0.12f),
                        shape = bubbleShape(isUser = true),
                    ) {
                        Text(
                            entry.text,
                            style = OpenAGIType.chatBody,
                            color = MaterialTheme.colorScheme.onBackground,
                            modifier = Modifier
                                .combinedClickable(onClick = {}, onLongClick = { clipboard.setText(AnnotatedString(entry.text)) })
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
            }
        }
        is ChatEntry.Assistant -> {
            Column(modifier = Modifier.fillMaxWidth()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(
                            onClick = {},
                            onLongClick = { if (entry.text.isNotBlank()) clipboard.setText(AnnotatedString(entry.text)) },
                        )
                        .padding(vertical = 2.dp),
                ) {
                    if (entry.streaming && entry.text.isBlank()) {
                        Column(modifier = Modifier.padding(vertical = 6.dp)) {
                            TypingDots()
                            entry.activity?.let { Text("$it…", style = OpenAGIType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp)) }
                        }
                    } else {
                        val textColor = if (entry.failed) colors.alert else MaterialTheme.colorScheme.onBackground
                        MarkdownView(entry.text, textColor = textColor, style = OpenAGIType.chatBody, onCanvas = true)
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

// Tapping a starter sends it as-is, exactly as if it had been typed.
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun StarterChips(starters: List<String>, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        starters.forEach { starter ->
            SuggestionChip(
                onClick = { onPick(starter) },
                label = { Text(starter, style = OpenAGIType.secondary) },
                border = BorderStroke(1.dp, LocalOpenAGIColors.current.edge),
                colors = SuggestionChipDefaults.suggestionChipColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    labelColor = MaterialTheme.colorScheme.onSurface,
                ),
            )
        }
    }
}

// A small round down arrow at the trailing edge, above the composer: a
// centred pill covered the full-width reply text it floated over.
private val JUMP_BUTTON_SIZE = 40.dp
private val JUMP_BUTTON_SPACE = JUMP_BUTTON_SIZE + 8.dp

@Composable
private fun JumpToLatestButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalOpenAGIColors.current
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = CircleShape,
        border = BorderStroke(1.dp, colors.edge),
        shadowElevation = 2.dp,
        modifier = modifier
            .size(JUMP_BUTTON_SIZE)
            .clip(CircleShape)
            .clickable(onClickLabel = "Jump to latest", role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "Jump to latest" },
    ) {
        Box(contentAlignment = Alignment.Center) {
            DownArrowGlyph(tint = MaterialTheme.colorScheme.onBackground)
        }
    }
}

// The readable column on a wide window: messages and composer stop growing
// at this width and centre, instead of running a line across a whole
// unfolded Fold or tablet. 600 keeps a line of chat text under about 70
// characters (DESIGN.md), at roughly 8.2dp per character as measured on a
// device; the unfolded Fold's inner screen (750 to 830 wide) gets it too.
internal val CHAT_MAX_WIDTH = 600.dp
private val CHAT_MIN_GUTTER = 16.dp

internal fun chatGutter(available: Dp): Dp = maxOf(CHAT_MIN_GUTTER, (available - CHAT_MAX_WIDTH) / 2)

// The composer pill sits 4 outside the text column on each side, so the
// text inside it lines up with the messages: 12 from the edge on a phone.
internal fun composerInset(gutter: Dp): Dp = maxOf(0.dp, gutter - 4.dp)

// Material text entry and button semantics, including selection, TalkBack,
// focus and keyboard behavior. The fold-aware parent owns the safe insets.
@Composable
private fun Composer(value: String, onValueChange: (String) -> Unit, enabled: Boolean, onSend: () -> Unit, gutter: Dp, onFocus: (Boolean) -> Unit = {}) {
    androidx.compose.material3.OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text("Message OpenAGI") },
        maxLines = 6,
        trailingIcon = { SendButton(enabled = enabled, onClick = onSend) },
        modifier = Modifier.fillMaxWidth().navigationBarsPadding()
            .padding(horizontal = maxOf(12.dp, composerInset(gutter)), vertical = 8.dp)
            .onFocusChanged { onFocus(it.isFocused) },
    )
}

// DESIGN.md: "Send is disabled and `muted` until there is non-whitespace
// text." A round arrow inside the pill: filled `live` when it can send, the
// arrow in `onLive` so it reads in both modes.
@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    androidx.compose.material3.FilledIconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.semantics { contentDescription = "Send" },
    ) {
        SendArrowGlyph(tint = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
