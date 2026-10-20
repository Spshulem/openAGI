@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package sh.openagi.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.onClick
import androidx.lifecycle.LifecycleEventObserver
import sh.openagi.mobile.voice.VoiceAudio
import sh.openagi.mobile.voice.VoiceSession
import sh.openagi.mobile.voice.VoiceStatus
import sh.openagi.mobile.voice.VoicePhase
import sh.openagi.mobile.voice.VoiceFocus
import android.content.Context
import android.content.Intent
import android.net.Uri
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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
import java.net.SocketTimeoutException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.FleetAction
import sh.openagi.mobile.protocol.FleetHealth
import sh.openagi.mobile.protocol.FleetMode
import sh.openagi.mobile.protocol.FleetOpenChat
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetState
import sh.openagi.mobile.protocol.FleetThread
import sh.openagi.mobile.protocol.FleetThreadDetail
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.NotifiedQuestionsStore
import sh.openagi.mobile.sync.AnswerOutcome
import sh.openagi.mobile.sync.SupervisorNotifier
import sh.openagi.mobile.sync.answerOutcome
import sh.openagi.mobile.sync.withAlertLock
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.markdown.MarkdownView
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy
import sh.openagi.mobile.util.RelativeTime

// FEATURES.md's "Supervisor": the fleet supervisor's view of every coding
// thread, read from /fleet/api/state. What needs a person comes first (its
// open questions), then Watching: every thread grouped by what the supervisor
// watches it for, with how long it has been that way. The mode, a manual
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
    showChatInline: Boolean = false,
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
    // The threads the noted question was about, so an open sheet shows only
    // its own answer's result.
    var questionNoteThreads by remember { mutableStateOf<List<String>>(emptyList()) }
    var questionNote by remember { mutableStateOf<Pair<String, SupervisorFormat.Note>?>(null) }
    var busyActionId by remember { mutableStateOf<String?>(null) }
    var actionNote by remember { mutableStateOf<Pair<String, SupervisorFormat.Note>?>(null) }
    // The thread whose sheet started the send: the sheet can be closed and
    // another thread opened while a nudge relays, and the result is not theirs.
    var actionNoteThread by remember { mutableStateOf<String?>(null) }
    var openThread by remember { mutableStateOf<FleetThread?>(null) }
    // The open sheet's thread as GET /fleet/api/threads/:key reads it: the
    // longer last message, the owner's last word. Null until it lands, and
    // on a daemon without the route, where the sheet shows the row alone.
    var detail by remember { mutableStateOf<FleetThreadDetail?>(null) }
    // Push now, Mute and Unmute: one at a time, and their result, by thread.
    var busyThread by remember { mutableStateOf<String?>(null) }
    var threadNote by remember { mutableStateOf<Pair<String, SupervisorFormat.Note>?>(null) }
    val voice = remember(credentials) { VoiceSession(credentials.server, credentials.token, VoiceAudio(context)) }
    val voiceStatus by voice.status.collectAsState()
    var voiceQuestion by remember { mutableStateOf<FleetQuestion?>(null) }
    var voiceAction by remember { mutableStateOf<FleetAction?>(null) }
    var permissionNote by remember { mutableStateOf<String?>(null) }
    val voicePermission = remember(voice) { VoicePermissionRequest() }
    val voiceLifecycle = LocalLifecycleOwner.current
    fun resumeHandsFree() {
        if (voicePermission.resume()) { permissionNote = null; voice.handsFree(true) }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionNote = if (granted) "Microphone allowed. Hold the mic to talk." else "Microphone permission is needed for voice. Allow it in Android Settings."
        voicePermission.result(granted)
        if (voiceLifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) resumeHandsFree()
    }
    fun microphoneAllowed(): Boolean = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    fun pressMic() {
        if (microphoneAllowed()) { permissionNote = null; voice.press() }
        else { voicePermission.cancel(); micPermission.launch(Manifest.permission.RECORD_AUDIO) }
    }
    fun toggleHandsFree() {
        if (voiceStatus.handsFree || microphoneAllowed()) {
            permissionNote = null
            voice.handsFree(!voiceStatus.handsFree)
        } else { voicePermission.handsFree(); micPermission.launch(Manifest.permission.RECORD_AUDIO) }
    }
    val voiceControls: @Composable () -> Unit = {
        SupervisorVoiceControls(voiceStatus, permissionNote, ::pressMic, { voice.release(it) }, ::toggleHandsFree, { voice.stop() })
    }
    DisposableEffect(voice, voiceLifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) voice.stop()
            if (voicePermission.lifecycle(event)) { permissionNote = null; voice.handsFree(true) }
        }
        voiceLifecycle.lifecycle.addObserver(observer)
        onDispose { voiceLifecycle.lifecycle.removeObserver(observer); voicePermission.cancel(); voice.close() }
    }
    LaunchedEffect(openThread, voiceQuestion, voiceAction) {
        voice.setFocus(VoiceFocus.supervisor(voiceQuestion, voiceAction, openThread))
    }
    var chatOpen by chatOpenState
    // The clock the Watching durations read; ticks while the list is visible.
    var now by remember { mutableStateOf(Instant.now()) }
    // Which Watching groups the owner opened or folded, kept across refreshes.
    val groupOpen = remember { mutableStateMapOf<String, Boolean>() }

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
        now = Instant.now()
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
        questionNoteThreads = listOfNotNull(question.threadKey) + question.threadKeys.orEmpty()
        scope.launch {
            try {
                val result = if (answer == null) client.fleetDismiss(question.id) else client.fleetAnswer(question.id, answer)
                val note = if (answer == null) {
                    SupervisorFormat.Note("Dismissed.", isAlert = false)
                } else {
                    SupervisorFormat.deliveryNote(result.delivery, "Answered.")
                }
                questionNote = question.id to note
                // Answered here: clear its ping, unless the daemon kept it open
                // because nothing was delivered.
                if (answer == null || answerOutcome(null, 0, result.delivery?.status) == AnswerOutcome.Done) {
                    withAlertLock {
                        SupervisorNotifier.cancel(context, question.id)
                        NotifiedQuestionsStore(context.filesDir).remove(question.id)
                    }
                }
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

    // The open sheet's thread, read again whenever the list is: a dropped
    // or unknown thread (404), or an older daemon, leaves the row as it is.
    suspend fun loadDetail(key: String) {
        try {
            val fresh = client.fleetThread(key).thread
            if (openThread?.key == key) detail = fresh?.takeIf { it.key == key }
        } catch (_: DaemonException) {
            // Keep what was last read; the row still says the rest.
        }
    }

    // Push now sends the planned nudge as the owner's own; Mute holds the
    // supervisor off the thread for a day; Unmute lets it back. Each result
    // carries the state, so the row moves group as soon as the daemon says.
    fun threadCall(thread: FleetThread, call: suspend () -> Pair<SupervisorFormat.Note, FleetState?>) {
        if (busyThread != null) return
        busyThread = thread.key
        threadNote = null
        scope.launch {
            try {
                val (note, fresh) = call()
                threadNote = thread.key to note
                // A fresh state reloads the open sheet's detail too.
                fresh?.let { accept(order.next(), it) } ?: refresh()
            } catch (error: DaemonException) {
                threadNote = thread.key to failureNote(error, credentials.server)
                if (error.meansAlreadyClosed()) refresh()
            } finally {
                busyThread = null
            }
        }
    }

    fun push(thread: FleetThread) = threadCall(thread) {
        val result = client.fleetPush(thread.key)
        WatchFormat.pushNote(result.delivery?.status, result.delivery?.detail) to result.state
    }

    fun mute(thread: FleetThread) = threadCall(thread) {
        val result = client.fleetMute(thread.key, 24)
        SupervisorFormat.Note("Muted for a day. The supervisor leaves it alone until then.", isAlert = false) to result.state
    }

    fun unmute(thread: FleetThread) = threadCall(thread) {
        val result = client.fleetUnmute(thread.key)
        SupervisorFormat.Note("Unmuted.", isAlert = false) to result.state
    }

    fun openSheet(thread: FleetThread) {
        if (openThread?.key != thread.key) detail = null
        openThread = thread
        voiceQuestion = null
        voiceAction = null
        actionNote = null
        threadNote = null
    }

    LaunchedEffect(resumeSignal, chatOpen, showChatInline) {
        if (!chatOpen || showChatInline) refresh()
    }

    // The sheet's detail: on opening, and again with each fresh state.
    LaunchedEffect(openThread?.key, lastSyncedAt) {
        openThread?.key?.let { loadDetail(it) }
    }

    // Every 30s while this screen is on screen and the app is in front; every
    // 5s while the daemon reports a scan running, so "Scanning…" clears soon
    // after it finishes. Stops while the supervisor chat covers the list.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner, chatOpen, showChatInline) {
        if (chatOpen && !showChatInline) return@LaunchedEffect
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                delay(if (state?.running == true) 5_000L else 30_000L)
                refresh()
            }
        }
    }

    // "for 23m" keeps counting between polls: every 30s while on screen.
    LaunchedEffect(lifecycleOwner, chatOpen, showChatInline) {
        if (chatOpen && !showChatInline) return@LaunchedEffect
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                now = Instant.now()
                delay(30_000L)
            }
        }
    }

    LaunchedEffect(chatOpen) { if (chatOpen) { voicePermission.cancel(); voice.stop() } }

    if (chatOpen && !showChatInline) {
        BackHandler { chatOpen = false }
        // The chat's own one-row top bar carries the back arrow.
        ChatScreen(
            context = context,
            credentials = credentials,
            streamAttached = streamAttached,
            title = "Supervisor",
            starters = SupervisorFormat.STARTERS,
            conversationState = chatConversationState,
            onBack = { chatOpen = false },
        )
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
                        item(key = "voice") {
                            voiceControls()
                            voiceQuestion?.let { Text("Voice context: " + (it.title ?: "Question"), style = OpenAGIType.caption) }
                        }
                        item(key = "needs") {
                            NeedsYouSection(
                                state = current,
                                now = now,
                                busyQuestionId = busyQuestionId,
                                note = questionNote,
                                onAnswer = { question, option -> decide(question, option) },
                                onDismiss = { question -> decide(question, null) },
                                onVoiceFocus = { voiceQuestion = it; voiceAction = null },
                                onOpenThread = { key -> current.snapshot?.threads?.firstOrNull { it.key == key }?.let(::openSheet) },
                            )
                        }
                        item(key = "threads") {
                            ThreadsSection(
                                state = current,
                                now = now,
                                groupOpen = groupOpen,
                                onOpen = { openSheet(it) },
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
            detail = detail?.takeIf { it.key == thread.key },
            // The questions open now, as Needs you shows them, so one
            // answered there leaves here at the same moment.
            questions = WatchFormat.questionsFor(thread.key, current?.questions.orEmpty()),
            now = now,
            proposed = if (current?.mode == FleetMode.PROPOSE) SupervisorFormat.proposedFor(thread, current.actions) else emptyList(),
            busyActionId = busyActionId,
            actionNote = actionNote?.takeIf { actionNoteThread == thread.key },
            onSend = { send(it) },
            busyQuestionId = busyQuestionId,
            // Only a note from a question about this thread.
            questionNote = questionNote?.takeIf { questionNoteThreads.contains(thread.key) },
            onAnswer = { question, option -> decide(question, option) },
            onDismissQuestion = { question -> decide(question, null) },
            onVoiceFocus = { voiceQuestion = it; voiceAction = null },
            onVoiceAction = { voiceAction = it; voiceQuestion = null },
            voiceControls = {
                voiceControls()
                voiceQuestion?.let { Text("Voice context: " + (it.title ?: "Question"), style = OpenAGIType.caption) }
                voiceAction?.let { Text("Voice context: proposed nudge", style = OpenAGIType.caption) }
            },
            busy = busyThread == thread.key,
            anyBusy = busyThread != null,
            threadNote = threadNote?.takeIf { it.first == thread.key }?.second,
            onPush = { push(thread) },
            onMute = { mute(thread) },
            onUnmute = { unmute(thread) },
            onDismiss = {
                openThread = null
                voiceQuestion = null
                voiceAction = null
                detail = null
            },
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
    now: Instant,
    busyQuestionId: String?,
    note: Pair<String, SupervisorFormat.Note>?,
    onAnswer: (FleetQuestion, String) -> Unit,
    onDismiss: (FleetQuestion) -> Unit,
    onVoiceFocus: (FleetQuestion) -> Unit,
    onOpenThread: (String) -> Unit,
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
                        now = now,
                        busy = busyQuestionId == question.id,
                        anyBusy = busyQuestionId != null,
                        note = note?.takeIf { it.first == question.id }?.second,
                        onAnswer = { onAnswer(question, it) },
                        onDismiss = { onDismiss(question) },
                    onVoiceFocus = { onVoiceFocus(question) },
                        onOpenThread = onOpenThread,
                    )
                    if (index != questions.lastIndex) Hairline()
                }
            }
        }
    }
}

// One open question: what it asks, when the agent asked and in which chat,
// where it is answered, and Open chat. A risky ask (a merge, a release, a
// deploy, a delete) shows the agent's whole message, marked, before any
// button; any other card shows it on a tap, with a way into the thread.
@Composable
private fun QuestionRow(
    question: FleetQuestion,
    threads: List<FleetThread>,
    now: Instant,
    busy: Boolean,
    anyBusy: Boolean,
    note: SupervisorFormat.Note?,
    onAnswer: (String) -> Unit,
    onDismiss: () -> Unit,
    onVoiceFocus: () -> Unit,
    onOpenThread: ((String) -> Unit)? = null,
    // Off in the thread sheet, whose header already carries Open chat.
    showChat: Boolean = true,
) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    var expanded by remember(question.id) { mutableStateOf(false) }
    val thread = question.threadKey?.let { key -> threads.firstOrNull { it.key == key } }
    val group = (question.threadKeys?.size ?: 0) > 1
    val asked = WatchFormat.askedLine(question, if (group) "${question.threadKeys!!.size} threads" else thread?.let(SupervisorFormat::name), now)
    val context = listOfNotNull(asked, SupervisorFormat.prNumber(question.prRef))
    val askContext = question.askContext?.takeIf { it.isNotBlank() }
    val canExpand = (!question.risky && askContext != null) || (thread != null && onOpenThread != null)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (canExpand) Modifier.clickable(onClickLabel = if (expanded) "Show less" else "Show more") { expanded = !expanded } else Modifier)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (question.risky) {
            Text("Read it all first: this one can't be undone easily.", style = OpenAGIType.caption, color = colors.alert)
        }
        Text(question.title?.takeIf { it.isNotBlank() } ?: "Question", style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
        if (context.isNotEmpty()) Text(context.joinToString(" · "), style = OpenAGIType.caption, color = muted)
        question.body?.takeIf { it.isNotBlank() }?.let { MarkdownView(it, textColor = muted, style = OpenAGIType.secondary) }
        if (askContext != null && (question.risky || expanded)) {
            Text("The agent wrote (unverified)", style = OpenAGIType.caption, color = muted, modifier = Modifier.padding(top = 4.dp))
            Surface(color = colors.edge, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                Box(modifier = Modifier.padding(10.dp)) {
                    MarkdownView(askContext, textColor = MaterialTheme.colorScheme.onSurface, style = OpenAGIType.secondary)
                }
            }
        }
        if (canExpand && !expanded) Text("Tap for more", style = OpenAGIType.caption, color = muted)
        if (question.answeredInAgentApp) {
            val app = WatchFormat.appName(question.openChat?.app) ?: "the agent's app"
            Text("Answer it in $app: the agent reads the reply there.", style = OpenAGIType.caption, color = colors.caution)
        }
        // A group's question names each of its chats; any other, its own.
        if (showChat && question.chats.isNotEmpty()) {
            question.chats.forEach { OpenChatLine(it.openChat) }
        } else if (showChat) {
            OpenChatLine(question.openChat ?: thread?.openChat)
        }
        if (expanded && thread != null && onOpenThread != null) {
            TextButton(onClick = { onOpenThread(thread.key) }, modifier = Modifier.heightIn(min = 44.dp)) {
                Text("Thread details", style = OpenAGIType.secondary, color = colors.live)
            }
        }
        // "dismiss" can arrive as an option; it is the Dismiss button below.
        val options = WatchFormat.answerOptions(question)
        FlowRow(
            modifier = Modifier.padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            options.forEachIndexed { index, option ->
                CompactButton(text = option, filled = index == 0 && !question.risky, enabled = !anyBusy, onClick = { onAnswer(option) })
            }
            TextButton(onClick = onVoiceFocus, modifier = Modifier.heightIn(min = 44.dp)) {
                Text("Talk about this", style = OpenAGIType.secondary, color = colors.live)
            }
            TextButton(onClick = onDismiss, enabled = !anyBusy, modifier = Modifier.heightIn(min = 44.dp)) {
                Text("Dismiss", style = OpenAGIType.secondary, color = muted)
            }
        }
        if (busy) Text("Sending… an answer can take a few minutes to reach the agent.", style = OpenAGIType.caption, color = muted)
        note?.let { NoteLine(it) }
        if (question.kind == "agent-ask" && !question.answeredInAgentApp) Text("Your answer goes to the agent.", style = OpenAGIType.caption, color = muted)
    }
}

// Open chat, as far as this phone can: a button when an app here opens the
// link; otherwise the chat named with "on your Mac", since the link (or the
// sidebar, when there is none) only works there. Never a dead link.
@Composable
private fun OpenChatLine(chat: FleetOpenChat?) {
    val context = LocalContext.current
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val link = remember(chat) { WatchFormat.chatLink(chat) { url -> canOpenHere(context, url) } } ?: return
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (link.url != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clickable(role = Role.Button, onClickLabel = "Open chat") { openHere(context, link.url) },
            ) {
                Text("Open chat", style = OpenAGIType.secondary, color = colors.live)
                Text(
                    link.label,
                    style = OpenAGIType.caption,
                    color = muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        } else {
            Text("Chat: " + link.label, style = OpenAGIType.caption, color = MaterialTheme.colorScheme.onSurface)
            val where = WatchFormat.chatInstruction(link)
            Text(where, style = OpenAGIType.caption, color = muted)
        }
    }
}

// Whether an app on this phone takes the link (AndroidManifest's <queries>
// names the schemes, so the answer is not always "no").
private fun canOpenHere(context: Context, url: String): Boolean = runCatching {
    context.packageManager.queryIntentActivities(Intent(Intent.ACTION_VIEW, Uri.parse(url)), 0).isNotEmpty()
}.getOrDefault(false)

private fun openHere(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

// Watching: every thread grouped by what the supervisor watches it for
// (waiting on you, working, waiting on CI or BuildBot3, ...), longest wait
// first, each with how long it has been that way. A daemon from before watch
// groups by state instead. Quiet and out-of-scope groups start folded.
@Composable
private fun ThreadsSection(
    state: FleetState,
    now: Instant,
    groupOpen: MutableMap<String, Boolean>,
    onOpen: (FleetThread) -> Unit,
) {
    val snapshot = state.snapshot
    val threads = snapshot?.threads.orEmpty()
    val groups = WatchFormat.groups(threads)
    val proposing = state.mode == FleetMode.PROPOSE
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text("Watching", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
            val inScope = snapshot?.counts?.inScope?.takeIf { it > 0 } ?: threads.size
            if (threads.isNotEmpty()) {
                Text("$inScope", style = OpenAGIType.secondary, color = muted, modifier = Modifier.padding(start = 8.dp, bottom = 2.dp))
            }
        }
        when {
            snapshot == null -> RowGroup { InlineMessage("No scan yet. Tap Scan now.") }
            threads.isEmpty() -> RowGroup { InlineMessage("No recent coding threads.") }
            else -> groups.forEach { group ->
                val open = groupOpen[group.key] ?: !group.collapsedByDefault
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    WatchGroupHeader(group = group, open = open, onToggle = { groupOpen[group.key] = !open })
                    if (open) {
                        RowGroup {
                            group.threads.forEachIndexed { index, thread ->
                                ThreadRow(
                                    thread = thread,
                                    group = group.key,
                                    now = now,
                                    hasProposal = proposing && SupervisorFormat.proposedFor(thread, state.actions).isNotEmpty(),
                                    onClick = { onOpen(thread) },
                                )
                                if (index != group.threads.lastIndex) Hairline()
                            }
                        }
                    }
                }
            }
        }
    }
}

// The group's name in its tone, the count, and Show or Hide; the whole line
// toggles the group.
@Composable
private fun WatchGroupHeader(group: WatchFormat.Group, open: Boolean, onToggle: () -> Unit) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val tone = when (group.key) {
        "you", "needs-human", "ready-needs-human" -> colors.alert
        "push", "blocked", "stopped", "asked-in-scope", "pr-not-ready", "infra-blocked", "local-verify" -> colors.caution
        "working", "waiting", "waiting-ci", "running" -> colors.live
        else -> muted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clickable(onClickLabel = if (open) "Hide" else "Show", role = Role.Button, onClick = onToggle),
    ) {
        Text(group.label, style = OpenAGIType.secondary, color = tone, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text("${group.threads.size}", style = OpenAGIType.secondary, color = muted, modifier = Modifier.padding(start = 8.dp))
        Box(modifier = Modifier.weight(1f))
        Text(if (open) "Hide" else "Show", style = OpenAGIType.caption, color = muted)
    }
}

// One line of name and PR, one line of how long ("on BuildBot3 full run for
// 23m"), and the reason where the thread needs something.
@Composable
private fun ThreadRow(thread: FleetThread, group: String, now: Instant, hasProposal: Boolean, onClick: () -> Unit) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val ciFailing = SupervisorFormat.ciFailing(thread.pr?.ci)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clickable(onClickLabel = "Open details", onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            HealthDot(FleetHealth.of(thread))
            Text(
                SupervisorFormat.name(thread),
                style = OpenAGIType.body,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 10.dp),
            )
            WatchFormat.prShortRef(thread.pr?.ref)?.let {
                Text(
                    it,
                    style = OpenAGIType.caption,
                    color = if (ciFailing) colors.alert else muted,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        val time = thread.watch?.takeIf { it.since != null }?.let { WatchFormat.watchLine(it, now) }
            ?: thread.lastActivityAt?.let { WatchFormat.ago(it, now) }
        val line = listOfNotNull(
            time,
            if (ciFailing) "CI failing" else null,
            if (hasProposal) "Nudge ready" else null,
            if (WatchFormat.mutedLine(thread.muted, now) != null) "Muted" else null,
        ).joinToString(" · ")
        if (line.isNotEmpty()) {
            Text(line, style = OpenAGIType.caption, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 18.dp))
        }
        if (group in REASON_GROUPS) {
            (thread.reason?.takeIf { it.isNotBlank() } ?: thread.blockers.firstOrNull())?.let {
                Text(it, style = OpenAGIType.caption, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 18.dp))
            }
        }
    }
}

// Groups where the why matters on the row itself: something is stuck or
// waiting on a person. Working, waiting on CI and quiet rows say enough.
private val REASON_GROUPS = setOf(
    "you", "push", "blocked",
    "needs-human", "ready-needs-human", "stopped", "asked-in-scope", "pr-not-ready", "infra-blocked",
)

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

// A Watching row expanded: Open chat, the questions open about it (answered
// here), Push now with the words it would send, Mute, then what it waits on
// and since when, its PR, the supervisor's next step and why, and the
// agent's last message. GET /fleet/api/threads/:key adds the longer message
// and the owner's last word; without it the row's own fields stand in.
@Composable
private fun ThreadDetailSheet(
    thread: FleetThread,
    detail: FleetThreadDetail?,
    questions: List<FleetQuestion>,
    now: Instant,
    proposed: List<FleetAction>,
    busyActionId: String?,
    actionNote: Pair<String, SupervisorFormat.Note>?,
    onSend: (FleetAction) -> Unit,
    busyQuestionId: String?,
    questionNote: Pair<String, SupervisorFormat.Note>?,
    onAnswer: (FleetQuestion, String) -> Unit,
    onDismissQuestion: (FleetQuestion) -> Unit,
    onVoiceFocus: (FleetQuestion) -> Unit,
    voiceControls: @Composable () -> Unit,
    onVoiceAction: (FleetAction) -> Unit,
    busy: Boolean,
    anyBusy: Boolean,
    threadNote: SupervisorFormat.Note?,
    onPush: () -> Unit,
    onMute: () -> Unit,
    onUnmute: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val uriHandler = LocalUriHandler.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val context = WatchFormat.detailContext(thread, detail)
    val pr = context.pr
    val decision = context.decision
    val agentText = detail?.lastAgentMessage?.text?.takeIf { it.isNotBlank() } ?: thread.lastAgentText
    val agentAt = detail?.lastAgentMessage?.at ?: thread.lastAgentAt
    val ownerAt = thread.lastOwnerAt ?: detail?.lastOwnerAt
    val actions = WatchFormat.rowActions(thread, now)

    val rows = buildList<@Composable () -> Unit> {
        // How long: what it is watched for, the turn, the wait, the agent.
        thread.watch?.let { watch ->
            val group = watch.group?.takeIf { it.isNotBlank() }?.let { WatchFormat.groupLabel(it, byWatch = true) }
            val value = listOfNotNull(group, WatchFormat.watchLine(watch, now)).joinToString(", ")
            if (value.isNotBlank()) add { DetailRow("Watching", value) }
        }
        WatchFormat.waitsOn(thread.watch, now)?.let { add { DetailRow("Waits on", it) } }
        thread.watch?.otherwise?.group?.takeIf { it.isNotBlank() }?.let { back ->
            add { DetailRow("Once you answer", WatchFormat.groupLabel(back, byWatch = true)) }
        }
        thread.watch?.runningSince?.let { started ->
            add { DetailRow("Turn running", WatchFormat.turnRunning(thread.watch, now) + " (since " + clockTime(started) + ")") }
        }
        WatchFormat.waiting(thread.watch, now)?.let { add { DetailRow("Waiting", it) } }
        agentAt?.let { add { DetailRow("Agent last spoke", WatchFormat.ago(it, now)) } }
        WatchFormat.ownerLine(ownerAt, now)?.let { add { DetailRow("You", it) } }
        thread.lastActivityAt?.let { add { DetailRow("Last activity", WatchFormat.ago(it, now)) } }
        thread.reason?.takeIf { it.isNotBlank() }?.let { add { DetailRow("Reason", it) } }
        if (thread.blockers.isNotEmpty()) add { DetailRow("Blockers", thread.blockers.joinToString("\n") { "• $it" }) }
        pr?.let { pr ->
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
        decision?.let { WatchFormat.nextStep(it.action, it.playbook) }?.let { step ->
            val next = step + (decision.notBefore?.let { ", not before " + clockTime(it) } ?: "")
            add { DetailRow("Supervisor's next step", next) }
            decision.reason?.takeIf { it.isNotBlank() }?.let { add { DetailRow("Why", it) } }
        }
        thread.error?.let { error ->
            val text = SupervisorFormat.errorKindLabel(error.kind) + (error.resetAt?.let { ", resets " + clockTime(it) } ?: "")
            add { DetailRow("Error", text, valueColor = colors.alert) }
        }
        val agent = listOfNotNull(WatchFormat.appName(thread.kind) ?: thread.kind, thread.agentStatus, if (thread.live) "live" else null).joinToString(", ")
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
                WatchFormat.mutedLine(thread.muted, now)?.let { Text(it, style = OpenAGIType.caption, color = colors.caution) }
                OpenChatLine(thread.openChat ?: detail?.openChat)
            }

            voiceControls()

            if (questions.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Waiting on you", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                    RowGroup {
                        questions.forEachIndexed { index, question ->
                            QuestionRow(
                                question = question,
                                threads = listOf(thread),
                                now = now,
                                busy = busyQuestionId == question.id,
                                anyBusy = busyQuestionId != null,
                                note = questionNote?.takeIf { it.first == question.id }?.second,
                                onAnswer = { onAnswer(question, it) },
                                onDismiss = { onDismissQuestion(question) },
                                onVoiceFocus = { onVoiceFocus(question) },
                                showChat = false,
                            )
                            if (index != questions.lastIndex) Hairline()
                        }
                    }
                }
            }
            // An answered question leaves; its result still shows here.
            questionNote?.takeIf { note -> questions.none { it.id == note.first } }?.let { NoteLine(it.second) }

            if (actions.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (WatchFormat.RowAction.PUSH in actions) {
                        val message = thread.pushPreview?.message?.takeIf { it.isNotBlank() }
                        Text("Push now", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                        if (message != null) {
                            Text("Sends this to the agent now, as you:", style = OpenAGIType.caption, color = muted)
                            Surface(color = colors.edge, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                                Text(message, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(10.dp))
                            }
                            PrimaryButton(text = "Push now", onClick = onPush, enabled = !anyBusy && !thread.pushing, loading = busy || thread.pushing)
                        } else {
                            Text("The supervisor has nothing planned to send yet.", style = OpenAGIType.caption, color = muted)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (WatchFormat.RowAction.MUTE in actions) {
                            CompactButton(text = "Mute for a day", filled = false, enabled = !anyBusy, onClick = onMute)
                        }
                        if (WatchFormat.RowAction.UNMUTE in actions) {
                            CompactButton(text = "Unmute", filled = false, enabled = !anyBusy, onClick = onUnmute)
                        }
                    }
                }
            }
            if (busy) Text("Sending… a push can take a few minutes to reach the agent.", style = OpenAGIType.caption, color = muted)
            threadNote?.let { NoteLine(it) }

            if (rows.isNotEmpty()) {
                RowGroup {
                    rows.forEachIndexed { index, row ->
                        row()
                        if (index != rows.lastIndex) Hairline()
                    }
                }
            }

            agentText?.takeIf { it.isNotBlank() }?.let { text ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Last agent message (unverified)", style = OpenAGIType.caption, color = muted)
                    Surface(color = colors.edge, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                        Box(modifier = Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(10.dp)) {
                            MarkdownView(text, textColor = MaterialTheme.colorScheme.onSurface, style = OpenAGIType.secondary)
                        }
                    }
                }
            }

            proposed.forEach { action ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onVoiceAction(action) }) { Text("Talk about this nudge", style = OpenAGIType.secondary) }
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


@Composable
private fun SupervisorVoiceControls(
    status: VoiceStatus,
    permissionNote: String?,
    onPress: () -> Unit,
    onRelease: (Boolean) -> Unit,
    onHandsFree: () -> Unit,
    onStop: () -> Unit,
) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            val label = when {
                status.handsFree -> "Mic · Hands-free"
                status.recording -> "Mic · Listening…"
                status.phase == VoicePhase.CONNECTING -> "Mic · Connecting…"
                else -> "Mic · Hold to talk"
            }
            Surface(
                color = if (status.recording) colors.live.copy(alpha = 0.15f) else colors.edge,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                    .semantics {
                        role = Role.Button
                        onClick(label = "Start or finish a voice turn") {
                            if (status.handsFree) onStop() else if (status.recording) onRelease(true) else onPress()
                            true
                        }
                    }
                    .pointerInput(status.handsFree) {
                        detectTapGestures(onPress = {
                            if (status.handsFree) { onStop(); return@detectTapGestures }
                            onPress()
                            val released = tryAwaitRelease()
                            onRelease(released)
                        })
                    },
            ) {
                Text(label, style = OpenAGIType.secondary, color = colors.live, modifier = Modifier.padding(12.dp))
            }
            TextButton(onClick = onHandsFree, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (status.handsFree) "Hands-free off" else "Hands-free on", style = OpenAGIType.secondary)
            }
        }
        if (status.phase != VoicePhase.IDLE) {
            TextButton(onClick = onStop) { Text("End voice", style = OpenAGIType.secondary) }
        }
        (permissionNote ?: status.message)?.let { Text(it, style = OpenAGIType.caption, color = muted) }
        if (status.ownerText.isNotBlank()) Text("You: " + status.ownerText, style = OpenAGIType.secondary)
        if (status.replyText.isNotBlank()) Text("Supervisor: " + status.replyText, style = OpenAGIType.secondary)
    }
}
