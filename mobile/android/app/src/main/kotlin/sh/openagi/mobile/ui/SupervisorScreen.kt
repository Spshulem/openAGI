@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package sh.openagi.mobile.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.FleetAction
import sh.openagi.mobile.protocol.FleetHealth
import sh.openagi.mobile.protocol.FleetMode
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetState
import sh.openagi.mobile.protocol.FleetThread
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy
import sh.openagi.mobile.util.RelativeTime
import java.net.SocketTimeoutException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// FEATURES.md's "Supervisor": the fleet supervisor's view of every coding
// thread, read from /fleet/api/state. What needs a person comes first (its
// open questions), then every thread, worst health first. The mode, a manual
// scan and a supervisor chat sit in the header. Nothing here is optimistic:
// a mode change, an answer or a sent nudge shows only once the daemon says so,
// the same rule approvals follow.
@Composable
fun SupervisorScreen(
    context: Context,
    credentials: Credentials,
    resumeSignal: Int = 0,
    streamAttached: Boolean = false,
    chatConversationState: ChatConversationState,
    // Held by the Activity so leaving the tab, or the phone folding, returns
    // to the open supervisor conversation rather than the dashboard.
    chatOpenState: MutableState<Boolean> = remember { mutableStateOf(false) },
) {
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val scope = rememberCoroutineScope()
    val order = remember { ResponseOrder() }

    var state by remember { mutableStateOf<FleetState?>(null) }
    var loadError by remember { mutableStateOf<DaemonException?>(null) }
    var lastSyncedAt by remember { mutableStateOf<Instant?>(null) }
    var lastLoadFailed by remember { mutableStateOf(false) }
    var pulling by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var scanNote by remember { mutableStateOf<SupervisorFormat.Note?>(null) }
    var modeBusy by remember { mutableStateOf(false) }
    var modeNote by remember { mutableStateOf<SupervisorFormat.Note?>(null) }
    var confirmAuto by remember { mutableStateOf(false) }
    var busyQuestionId by remember { mutableStateOf<String?>(null) }
    var questionNote by remember { mutableStateOf<Pair<String, SupervisorFormat.Note>?>(null) }
    var busyActionId by remember { mutableStateOf<String?>(null) }
    var actionNote by remember { mutableStateOf<Pair<String, SupervisorFormat.Note>?>(null) }
    // The thread whose sheet started the send: the sheet can be closed and
    // another thread opened while a nudge relays, and the result is not theirs.
    var actionNoteThread by remember { mutableStateOf<String?>(null) }
    var openThread by remember { mutableStateOf<FleetThread?>(null) }
    var chatOpen by chatOpenState

    // Responses can land out of order: a 30s poll sent while an answer was
    // relaying may return after it with the state from before. A poll is
    // numbered when sent, a mutation's reply when it arrives, and nothing
    // older than what is already on screen replaces it.
    fun accept(seq: Int, fresh: FleetState) {
        if (!order.accept(seq)) return
        state = fresh
        loadError = null
        lastLoadFailed = false
        lastSyncedAt = Instant.now()
    }

    fun reject(seq: Int, error: DaemonException) {
        if (!order.accept(seq)) return
        loadError = error
        // A daemon without a supervisor answered, so it is reachable: the
        // connection line must not claim otherwise.
        lastLoadFailed = error !is DaemonException.Unavailable
        if (!lastLoadFailed) lastSyncedAt = Instant.now()
    }

    suspend fun refresh() {
        val seq = order.next()
        try {
            accept(seq, client.fleetState())
        } catch (error: DaemonException) {
            reject(seq, error)
        }
    }

    fun scan() {
        if (scanning) return
        scanning = true
        scanNote = null
        scope.launch {
            try {
                val fresh = client.fleetScan()
                accept(order.next(), fresh)
            } catch (error: DaemonException) {
                scanNote = if (error.isTimeout()) {
                    SupervisorFormat.Note("The scan is taking a while. Pull to refresh in a minute.", isAlert = false)
                } else {
                    SupervisorFormat.Note(supervisorErrorCopy(error, credentials.server).headline, isAlert = true)
                }
                refresh()
            } finally {
                scanning = false
            }
        }
    }

    fun setMode(mode: String) {
        if (modeBusy || state?.mode == mode) return
        modeBusy = true
        modeNote = null
        scope.launch {
            try {
                val fresh = client.fleetSetMode(mode)
                accept(order.next(), fresh)
            } catch (error: DaemonException) {
                modeNote = SupervisorFormat.Note(supervisorErrorCopy(error, credentials.server).headline, isAlert = true)
            } finally {
                modeBusy = false
            }
        }
    }

    // answer == null is a dismissal.
    fun decide(question: FleetQuestion, answer: String?) {
        if (busyQuestionId != null) return
        busyQuestionId = question.id
        questionNote = null
        scope.launch {
            try {
                val result = if (answer == null) client.fleetDismiss(question.id) else client.fleetAnswer(question.id, answer)
                val note = if (answer == null) {
                    SupervisorFormat.Note("Dismissed.", isAlert = false)
                } else {
                    SupervisorFormat.deliveryNote(result.delivery, "Answered.")
                }
                questionNote = question.id to note
                result.state?.let { accept(order.next(), it) } ?: refresh()
            } catch (error: DaemonException) {
                questionNote = question.id to failureNote(error, credentials.server)
                // Closed or gone elsewhere: show what is actually open now.
                if (error.meansAlreadyClosed()) refresh()
            } finally {
                busyQuestionId = null
            }
        }
    }

    fun send(action: FleetAction) {
        if (busyActionId != null) return
        busyActionId = action.id
        actionNote = null
        actionNoteThread = openThread?.key
        scope.launch {
            try {
                val result = client.fleetSendAction(action.id)
                actionNote = action.id to SupervisorFormat.deliveryNote(result.delivery, "Sent.")
                result.state?.let { accept(order.next(), it) } ?: refresh()
            } catch (error: DaemonException) {
                actionNote = action.id to failureNote(error, credentials.server)
                if (error.meansAlreadyClosed()) refresh()
            } finally {
                busyActionId = null
            }
        }
    }

    LaunchedEffect(resumeSignal, chatOpen) {
        if (!chatOpen) refresh()
    }

    // Every 30s while this screen is on screen and the app is in front; every
    // 5s while the daemon reports a scan running, so "Scanning…" clears soon
    // after it finishes. Stops while the supervisor chat covers the list.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner, chatOpen) {
        if (chatOpen) return@LaunchedEffect
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                delay(if (state?.running == true) 5_000L else 30_000L)
                refresh()
            }
        }
    }

    if (chatOpen) {
        BackHandler { chatOpen = false }
        Column(modifier = Modifier.fillMaxSize()) {
            TextButton(onClick = { chatOpen = false }, modifier = Modifier.padding(start = 8.dp, top = 4.dp)) {
                Text("Back", style = OpenAGIType.body, color = LocalOpenAGIColors.current.live)
            }
            Box(modifier = Modifier.weight(1f)) {
                ChatScreen(
                    context = context,
                    credentials = credentials,
                    streamAttached = streamAttached,
                    title = "Supervisor",
                    sessionId = SupervisorFormat.SESSION_ID,
                    from = SupervisorFormat.SESSION_ID,
                    starters = SupervisorFormat.STARTERS,
                    conversationState = chatConversationState,
                )
            }
        }
        return
    }

    val syncedAgo = lastSyncedAt?.let { ageMinutes(it) }
    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "Supervisor",
            connection = when {
                lastLoadFailed -> ConnectionState.Failed(credentials.server, syncedAgo)
                syncedAgo != null -> ConnectionState.Synced(credentials.server, syncedAgo)
                else -> ConnectionState.NeverSynced(credentials.server)
            },
        )

        PullToRefreshBox(
            isRefreshing = pulling,
            onRefresh = {
                scope.launch {
                    pulling = true
                    refresh()
                    pulling = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            val current = state
            val error = loadError
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                when {
                    error is DaemonException.Unavailable || (current == null && error != null) -> item(key = "empty") {
                        val copy = supervisorErrorCopy(error, credentials.server)
                        EmptyState(copy.headline, copy.detail, modifier = Modifier.fillParentMaxSize())
                    }
                    current == null -> item(key = "loading") {
                        EmptyState("Loading…", modifier = Modifier.fillParentMaxSize())
                    }
                    else -> {
                        item(key = "controls") {
                            SupervisorControls(
                                state = current,
                                modeBusy = modeBusy,
                                modeNote = modeNote,
                                scanning = scanning || current.running,
                                scanNote = scanNote,
                                // Tapping Auto while already in Auto must not ask to turn it on.
                                onMode = { mode -> if (mode == FleetMode.AUTO && current.mode != FleetMode.AUTO) confirmAuto = true else setMode(mode) },
                                onScan = { scan() },
                                onAsk = { chatOpen = true },
                            )
                        }
                        item(key = "needs") {
                            NeedsYouSection(
                                state = current,
                                busyQuestionId = busyQuestionId,
                                note = questionNote,
                                onAnswer = { question, option -> decide(question, option) },
                                onDismiss = { question -> decide(question, null) },
                            )
                        }
                        item(key = "threads") {
                            ThreadsSection(
                                state = current,
                                onOpen = {
                                    openThread = it
                                    actionNote = null
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    if (confirmAuto) {
        AlertDialog(
            onDismissRequest = { confirmAuto = false },
            title = { Text("Turn on Auto?", style = OpenAGIType.section) },
            text = {
                Text(
                    "In Auto the supervisor sends preset nudges to your agents by itself, a few per scan, " +
                        "without asking first. Observe and Propose never send on their own.",
                    style = OpenAGIType.secondary,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            confirmButton = {
                PrimaryButton(text = "Turn on Auto", onClick = {
                    confirmAuto = false
                    setMode(FleetMode.AUTO)
                })
            },
            dismissButton = {
                TextButton(onClick = { confirmAuto = false }) { Text("Cancel") }
            },
        )
    }

    openThread?.let { opened ->
        // Follow the thread through refreshes; if a scan drops it, keep
        // showing what was last known rather than yanking the sheet away.
        val current = state
        val thread = current?.snapshot?.threads?.firstOrNull { it.key == opened.key } ?: opened
        ThreadDetailSheet(
            thread = thread,
            proposed = if (current?.mode == FleetMode.PROPOSE) SupervisorFormat.proposedFor(thread, current.actions) else emptyList(),
            busyActionId = busyActionId,
            actionNote = actionNote?.takeIf { actionNoteThread == thread.key },
            onSend = { send(it) },
            onDismiss = { openThread = null },
        )
    }
}

// Same wording as every other screen, with one addition: a phone credential
// refused on these routes alone most likely means a daemon from before the
// supervisor was opened to phones, not a revoked pairing.
private fun supervisorErrorCopy(error: DaemonException, host: String): ErrorCopy.Message =
    if (error is DaemonException.Unauthorized) {
        ErrorCopy.Message(
            "Supervisor isn't open to this phone.",
            "Update OpenAGI on that machine. If the other tabs fail too, re-pair in Settings.",
        )
    } else {
        ErrorCopy.forDaemon(error, host)
    }

private fun DaemonException.isTimeout(): Boolean =
    this is DaemonException.Transport && cause is SocketTimeoutException

// On a question or a proposed nudge, 404 (no longer open) and 409 (closed or
// no longer proposed while this request ran) mean the same thing to a person.
private fun DaemonException.meansAlreadyClosed(): Boolean =
    this is DaemonException.Conflict || this is DaemonException.NotFound

// Why an answer or a Send did not go through. A read timeout is not a
// failure: the relay may still be delivering it.
private fun failureNote(error: DaemonException, host: String): SupervisorFormat.Note = when {
    error.isTimeout() -> SupervisorFormat.Note("No word from the agent yet. Pull to refresh to see if it went through.", isAlert = false)
    error.meansAlreadyClosed() -> SupervisorFormat.Note(ErrorCopy.forDaemon(DaemonException.Conflict(), host).headline, isAlert = false)
    else -> SupervisorFormat.Note(supervisorErrorCopy(error, host).headline, isAlert = true)
}

private fun ageMinutes(instant: Instant): Int =
    ((Instant.now().epochSecond - instant.epochSecond) / 60).toInt().coerceAtLeast(0)

private fun agoPhrase(instant: Instant): String {
    val minutes = ageMinutes(instant)
    return if (minutes <= 0) "just now" else RelativeTime.short(minutes) + " ago"
}

// "3:40 PM" today, "Sep 28, 3:40 PM" otherwise.
private fun clockTime(instant: Instant): String {
    val zone = ZoneId.systemDefault()
    val sameDay = instant.atZone(zone).toLocalDate() == LocalDate.now(zone)
    val pattern = if (sameDay) "h:mm a" else "MMM d, h:mm a"
    return DateTimeFormatter.ofPattern(pattern).withZone(zone).format(instant)
}

private class ResponseOrder {
    private var issued = 0
    private var applied = 0

    fun next(): Int = ++issued

    fun accept(seq: Int): Boolean {
        if (seq < applied) return false
        applied = seq
        return true
    }
}

@Composable
private fun healthColor(health: FleetHealth): Color {
    val colors = LocalOpenAGIColors.current
    return when (health) {
        FleetHealth.RED -> colors.alert
        FleetHealth.YELLOW -> colors.caution
        FleetHealth.GREEN -> colors.live
        FleetHealth.GRAY -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

@Composable
private fun HealthDot(health: FleetHealth) {
    Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(healthColor(health)))
}

// "Red · Needs you": the colour named in words beside the dot, so colour is
// never the only signal.
@Composable
private fun HealthAndState(thread: FleetThread, style: androidx.compose.ui.text.TextStyle) {
    val health = FleetHealth.of(thread)
    val color = healthColor(health)
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = color)) { append(SupervisorFormat.healthLabel(health)) }
            append(" · ")
            append(SupervisorFormat.stateLabel(thread.state))
        },
        style = style,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun NoteLine(note: SupervisorFormat.Note, modifier: Modifier = Modifier) {
    Text(
        note.text,
        style = OpenAGIType.caption,
        color = if (note.isAlert) LocalOpenAGIColors.current.alert else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier,
    )
}

@Composable
private fun InlineMessage(text: String) {
    Text(
        text,
        style = OpenAGIType.caption,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
    )
}

// A 44-tall button that can sit several to a row: filled `live` for the
// action a person most likely wants, outlined for the rest. PrimaryButton is
// full width by design, which a row of answer options cannot be.
@Composable
private fun CompactButton(
    text: String,
    filled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = LocalOpenAGIColors.current
    val shape = RoundedCornerShape(10.dp)
    val fill = if (filled) {
        Modifier.background(if (enabled) colors.live else colors.live.copy(alpha = 0.4f))
    } else {
        Modifier.border(1.dp, colors.live.copy(alpha = if (enabled) 0.5f else 0.2f), shape)
    }
    Box(
        modifier = modifier
            .heightIn(min = 44.dp)
            .clip(shape)
            .then(fill)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        val textColor = when {
            filled -> Color.White
            enabled -> colors.live
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        }
        Text(text, style = OpenAGIType.secondary, color = textColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SupervisorControls(
    state: FleetState,
    modeBusy: Boolean,
    modeNote: SupervisorFormat.Note?,
    scanning: Boolean,
    scanNote: SupervisorFormat.Note?,
    onMode: (String) -> Unit,
    onScan: () -> Unit,
    onAsk: () -> Unit,
) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            FleetMode.ALL.forEachIndexed { index, mode ->
                SegmentedButton(
                    selected = state.mode == mode,
                    onClick = { onMode(mode) },
                    enabled = !modeBusy,
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = FleetMode.ALL.size),
                    colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = colors.live.copy(alpha = 0.12f),
                        activeContentColor = colors.live,
                        activeBorderColor = muted.copy(alpha = 0.4f),
                        inactiveContainerColor = MaterialTheme.colorScheme.surface,
                        inactiveContentColor = MaterialTheme.colorScheme.onSurface,
                        inactiveBorderColor = muted.copy(alpha = 0.4f),
                    ),
                    // The selection is carried by the fill and colour; no
                    // checkmark glyph, which would be the app's only icon-font icon.
                    icon = {},
                    label = { Text(SupervisorFormat.modeLabel(mode), style = OpenAGIType.secondary) },
                )
            }
        }
        SupervisorFormat.modeHint(state.mode)?.let { Text(it, style = OpenAGIType.caption, color = muted) }
        modeNote?.let { NoteLine(it) }
        Text(SupervisorFormat.scanLine(state.lastTickAt, state.enabled, Instant.now()), style = OpenAGIType.caption, color = muted)
        SupervisorFormat.warning(state)?.let {
            Text(it, style = OpenAGIType.caption, color = colors.alert, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        scanNote?.let { NoteLine(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 4.dp)) {
            CompactButton(
                text = if (scanning) "Scanning…" else "Scan now",
                filled = false,
                enabled = !scanning,
                onClick = onScan,
                modifier = Modifier.weight(1f),
            )
            CompactButton(text = "Ask supervisor", filled = true, onClick = onAsk, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun NeedsYouSection(
    state: FleetState,
    busyQuestionId: String?,
    note: Pair<String, SupervisorFormat.Note>?,
    onAnswer: (FleetQuestion, String) -> Unit,
    onDismiss: (FleetQuestion) -> Unit,
) {
    val questions = state.questions.filter { it.id.isNotBlank() }
    val threads = state.snapshot?.threads.orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Needs you", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
        // An answered question leaves the list; its result still needs saying.
        if (note != null && questions.none { it.id == note.first }) NoteLine(note.second)
        RowGroup {
            if (questions.isEmpty()) {
                InlineMessage("Nothing needs you.")
            } else {
                questions.forEachIndexed { index, question ->
                    QuestionRow(
                        question = question,
                        threads = threads,
                        busy = busyQuestionId == question.id,
                        anyBusy = busyQuestionId != null,
                        note = note?.takeIf { it.first == question.id }?.second,
                        onAnswer = { onAnswer(question, it) },
                        onDismiss = { onDismiss(question) },
                    )
                    if (index != questions.lastIndex) Hairline()
                }
            }
        }
    }
}

@Composable
private fun QuestionRow(
    question: FleetQuestion,
    threads: List<FleetThread>,
    busy: Boolean,
    anyBusy: Boolean,
    note: SupervisorFormat.Note?,
    onAnswer: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val about = when {
        (question.threadKeys?.size ?: 0) > 1 -> "${question.threadKeys!!.size} threads"
        else -> question.threadKey?.let { key -> threads.firstOrNull { it.key == key }?.let(SupervisorFormat::name) }
    }
    val context = listOfNotNull(about, SupervisorFormat.prNumber(question.prRef), question.createdAt?.let(::agoPhrase))
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(question.title?.takeIf { it.isNotBlank() } ?: "Question", style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
        if (context.isNotEmpty()) Text(context.joinToString(" · "), style = OpenAGIType.caption, color = muted)
        question.body?.takeIf { it.isNotBlank() }?.let { Text(it, style = OpenAGIType.secondary, color = muted) }
        // "dismiss" can arrive as an option; it is the Dismiss button below.
        val options = question.options.filter { it.isNotBlank() && it != "dismiss" }
        FlowRow(
            modifier = Modifier.padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            options.forEachIndexed { index, option ->
                CompactButton(text = option, filled = index == 0, enabled = !anyBusy, onClick = { onAnswer(option) })
            }
            TextButton(onClick = onDismiss, enabled = !anyBusy, modifier = Modifier.heightIn(min = 44.dp)) {
                Text("Dismiss", style = OpenAGIType.secondary, color = muted)
            }
        }
        if (busy) Text("Sending… an answer can take a few minutes to reach the agent.", style = OpenAGIType.caption, color = muted)
        note?.let { NoteLine(it) }
        if (question.kind == "agent-ask") Text("Your answer goes to the agent.", style = OpenAGIType.caption, color = muted)
    }
}

@Composable
private fun ThreadsSection(state: FleetState, onOpen: (FleetThread) -> Unit) {
    val snapshot = state.snapshot
    val threads = SupervisorFormat.sorted(snapshot?.threads.orEmpty())
    val proposing = state.mode == FleetMode.PROPOSE
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Threads", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
        when {
            snapshot == null -> RowGroup { InlineMessage("No scan yet. Tap Scan now.") }
            threads.isEmpty() -> RowGroup { InlineMessage("No recent coding threads.") }
            else -> {
                Text(SupervisorFormat.summary(threads), style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
                RowGroup {
                    threads.forEachIndexed { index, thread ->
                        ThreadRow(
                            thread = thread,
                            hasProposal = proposing && SupervisorFormat.proposedFor(thread, state.actions).isNotEmpty(),
                            onClick = { onOpen(thread) },
                        )
                        if (index != threads.lastIndex) Hairline()
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadRow(thread: FleetThread, hasProposal: Boolean, onClick: () -> Unit) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clickable(onClickLabel = "Open details", onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            HealthDot(FleetHealth.of(thread))
            Text(
                SupervisorFormat.name(thread),
                style = OpenAGIType.body,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 10.dp),
            )
            thread.lastActivityAt?.let {
                Text(RelativeTime.short(ageMinutes(it)), style = OpenAGIType.caption, color = muted, modifier = Modifier.padding(start = 8.dp))
            }
        }
        Column(modifier = Modifier.padding(start = 18.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            HealthAndState(thread, OpenAGIType.caption)
            (thread.reason?.takeIf { it.isNotBlank() } ?: thread.blockers.firstOrNull())?.let {
                Text(it, style = OpenAGIType.secondary, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            val chip = SupervisorFormat.prChip(thread.pr)
            if (chip != null || hasProposal) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                    chip?.let { Chip(it, color = if (SupervisorFormat.ciFailing(thread.pr?.ci)) colors.alert else MaterialTheme.colorScheme.onSurface) }
                    if (hasProposal) Chip("Nudge ready to send", color = colors.live)
                }
            }
        }
    }
}

@Composable
private fun Chip(text: String, color: Color) {
    Surface(color = MaterialTheme.colorScheme.background, shape = RoundedCornerShape(6.dp)) {
        Text(text, style = OpenAGIType.caption, color = color, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
    }
}

@Composable
private fun DetailRow(label: String, value: String, valueColor: Color? = null, onClick: (() -> Unit)? = null, action: String? = null) {
    val clickable = if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier
    Column(modifier = Modifier.fillMaxWidth().then(clickable).padding(horizontal = 20.dp, vertical = 12.dp)) {
        Text(label, style = OpenAGIType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = OpenAGIType.body, color = valueColor ?: MaterialTheme.colorScheme.onSurface)
        action?.let { Text(it, style = OpenAGIType.caption, color = LocalOpenAGIColors.current.live, modifier = Modifier.padding(top = 2.dp)) }
    }
}

@Composable
private fun ThreadDetailSheet(
    thread: FleetThread,
    proposed: List<FleetAction>,
    busyActionId: String?,
    actionNote: Pair<String, SupervisorFormat.Note>?,
    onSend: (FleetAction) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val uriHandler = LocalUriHandler.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val rows = buildList<@Composable () -> Unit> {
        thread.reason?.takeIf { it.isNotBlank() }?.let { add { DetailRow("Reason", it) } }
        if (thread.blockers.isNotEmpty()) add { DetailRow("Blockers", thread.blockers.joinToString("\n") { "• $it" }) }
        thread.pr?.let { pr ->
            val url = SupervisorFormat.prUrl(pr)
            val summary = listOfNotNull(
                SupervisorFormat.prNumber(pr.ref),
                SupervisorFormat.ciLabel(pr.ci),
                pr.unresolvedThreads?.takeIf { it > 0 }?.let { "$it open threads" },
                pr.state?.lowercase()?.replaceFirstChar { it.uppercase() },
            ).joinToString(" · ")
            val value = listOfNotNull(summary.ifBlank { null }, pr.title?.takeIf { it.isNotBlank() }).joinToString("\n")
            add {
                DetailRow(
                    label = "Pull request",
                    value = value.ifBlank { "Unknown" },
                    onClick = url?.let { { runCatching { uriHandler.openUri(it) } } },
                    action = url?.let { "Open in browser" },
                )
            }
            val failing = pr.ci?.failing.orEmpty()
            if (failing.isNotEmpty()) {
                add { DetailRow("Failing checks", failing.joinToString("\n"), valueColor = colors.alert) }
            }
        }
        thread.decision?.takeIf { !it.action.isNullOrBlank() && it.action != "none" }?.let { decision ->
            val next = listOfNotNull(
                decision.action,
                decision.playbook?.let { "($it)" },
            ).joinToString(" ") + (decision.notBefore?.let { ", not before " + clockTime(it) } ?: "")
            add { DetailRow("Next", next) }
            decision.reason?.takeIf { it.isNotBlank() }?.let { add { DetailRow("Why", it) } }
        }
        thread.error?.let { error ->
            val text = SupervisorFormat.errorKindLabel(error.kind) + (error.resetAt?.let { ", resets " + clockTime(it) } ?: "")
            add { DetailRow("Error", text, valueColor = colors.alert) }
        }
        val agent = listOfNotNull(thread.kind, thread.agentStatus, if (thread.live) "live" else null).joinToString(", ")
        if (agent.isNotBlank()) add { DetailRow("Agent", agent) }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(SupervisorFormat.name(thread), style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                // Repo and branch are machine identifiers, so mono.
                thread.repo?.takeIf { it.isNotBlank() }?.let { Text(it, style = OpenAGIType.dataMono, color = muted) }
                thread.branch?.takeIf { it.isNotBlank() }?.let { Text(it, style = OpenAGIType.dataMono, color = muted) }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                    HealthDot(FleetHealth.of(thread))
                    Box(modifier = Modifier.padding(start = 10.dp)) { HealthAndState(thread, OpenAGIType.secondary) }
                }
            }

            if (rows.isNotEmpty()) {
                RowGroup {
                    rows.forEachIndexed { index, row ->
                        row()
                        if (index != rows.lastIndex) Hairline()
                    }
                }
            }

            thread.lastAgentText?.takeIf { it.isNotBlank() }?.let { text ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Last agent message (unverified)", style = OpenAGIType.caption, color = muted)
                    Surface(color = colors.edge, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                        Box(modifier = Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()).padding(10.dp)) {
                            Text(text, style = OpenAGIType.dataMono, color = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            }

            proposed.forEach { action ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Proposed nudge", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                    action.message?.takeIf { it.isNotBlank() }?.let { Text(it, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface) }
                    (action.detail?.takeIf { it.isNotBlank() } ?: action.reason?.takeIf { it.isNotBlank() })?.let {
                        Text(it, style = OpenAGIType.secondary, color = muted)
                    }
                    PrimaryButton(
                        text = "Send",
                        onClick = { onSend(action) },
                        enabled = busyActionId == null,
                        loading = busyActionId == action.id,
                    )
                    actionNote?.takeIf { it.first == action.id }?.let { NoteLine(it.second) }
                }
            }
            // A sent nudge leaves the proposed list; its result still shows.
            actionNote?.takeIf { note -> proposed.none { it.id == note.first } }?.let { NoteLine(it.second) }
        }
    }
}
