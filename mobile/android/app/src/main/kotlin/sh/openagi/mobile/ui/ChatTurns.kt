package sh.openagi.mobile.ui

import kotlinx.coroutines.flow.Flow
import sh.openagi.mobile.protocol.ConversationPage
import sh.openagi.mobile.protocol.TurnStates
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SseFrame
import sh.openagi.mobile.util.ErrorCopy
import java.time.Duration
import java.time.Instant
import java.util.UUID

// Turn recovery (mobile/PROTOCOL.md §3.1 "Recovering a turn"). Android stops
// a backgrounded app's network, and connections drop. Main finishes a turn it
// accepted with no client attached; the phone finds that reply again in the
// thread's history by the turn id it sent, and never sends an accepted turn
// twice. A send main never confirmed is resent once with the same id, which
// main replays or follows rather than running again.
internal object ChatTurnRecovery {
    // Matches the dashboard and iOS: a turn can run several provider hops.
    val STALE_AFTER: Duration = Duration.ofMinutes(30)
    // Shown as the working line ("Still working…").
    const val STILL_WORKING = "Still working"
    const val NOT_SENT = "Not sent."
    const val NOT_SENT_DETAIL = "The connection dropped before OpenAGI confirmed it."
    const val INTERRUPTED = "This reply stopped before it finished."
    const val INTERRUPTED_DETAIL = "OpenAGI restarted while working on it."
    const val STALE = "No reply yet."
    const val STALE_DETAIL = "OpenAGI may still be working on it."
    const val FAILED = "OpenAGI couldn't reply."
    const val FAILED_DETAIL = "Try again."
    // GET /conversations/:thread/turns takes at most this many ids.
    const val MAX_TURN_IDS = 50

    fun newRequestId(): String = "android-" + UUID.randomUUID().toString()

    // After a history refresh: what each reply whose stream was lost has
    // become. `page.inFlight` is null from a main that cannot list running
    // turns; such a turn is waited on until it is stale.
    fun resolve(entries: List<ChatEntry>, page: ConversationPage, now: Instant = Instant.now()): List<ChatEntry> {
        val running = page.inFlight.orEmpty().map { it.requestId }.toSet()
        return entries.mapNotNull { entry ->
            val id = (entry as? ChatEntry.Assistant)?.takeIf { it.detached }?.requestId ?: return@mapNotNull entry
            val reply = entry as ChatEntry.Assistant
            when {
                // Main stored the reply (or its failure record): the merge
                // already shows it.
                page.messages.any { it.role == "assistant" && it.requestId == id } -> null
                id in running -> reply
                page.inFlight != null && page.messages.any { it.role == "user" && it.requestId == id } ->
                    failed(reply, INTERRUPTED, INTERRUPTED_DETAIL, newRequest = true)
                Duration.between(reply.timestamp, now) > STALE_AFTER -> failed(reply, STALE, STALE_DETAIL, newRequest = false)
                else -> reply
            }
        }
    }

    // Before any automatic resend: what main says each send it never
    // confirmed has become. Taken or finished: wait for it in history like
    // any lost stream, never resend. Failed or lost to a restart: the person
    // decides, and a retry is a new turn. Unknown (main never took it) stays
    // as it is, to be resent with the same id; an id main did not answer
    // about is left for the next pass.
    fun reconcile(entries: List<ChatEntry>, states: TurnStates): List<ChatEntry> {
        val byId = states.turns.associateBy { it.requestId }
        return entries.map { entry ->
            val reply = (entry as? ChatEntry.Assistant)?.takeIf { it.failed && it.autoRetry && it.requestId != null } ?: return@map entry
            when (byId[reply.requestId]?.state) {
                "queued", "running", "done" -> reply.copy(
                    text = "", failureDetail = null, streaming = true, failed = false, accepted = true, detached = true,
                    autoRetry = false, activity = STILL_WORKING,
                )
                "failed" -> failed(reply, FAILED, FAILED_DETAIL, newRequest = true).copy(autoRetry = false)
                "interrupted" -> failed(reply, INTERRUPTED, INTERRUPTED_DETAIL, newRequest = true).copy(autoRetry = false)
                else -> reply
            }
        }
    }

    fun stateOf(states: TurnStates, requestId: String?): String? = states.turns.firstOrNull { it.requestId == requestId }?.state

    private fun failed(reply: ChatEntry.Assistant, text: String, detail: String, newRequest: Boolean) = reply.copy(
        text = text, failureDetail = detail, streaming = false, failed = true, detached = false,
        activity = null, newRequestOnRetry = newRequest,
    )
}

// What a conversation's sends go through: the stream for one turn, the
// thread's history, and how a refusal reads. ChatScreen binds the real
// DaemonClient; tests bind fakes.
internal class ChatTransport(
    val send: (text: String, from: String?, sessionId: String?, thread: String?, requestId: String?) -> Flow<SseFrame>,
    val fetch: suspend (thread: String, before: String?) -> ConversationPage,
    // What main knows about named turns; null (or a NotFound) for a main
    // older than the turns route.
    val turns: (suspend (thread: String, requestIds: List<String>) -> TurnStates)? = null,
    val refusal: (DaemonException) -> ErrorCopy.Message,
    // A main that can't be reached, for one that predates turn ids.
    val unreachable: ErrorCopy.Message = ErrorCopy.Message("Can't reach OpenAGI.", "Try again."),
    val from: String? = null,
    val sessionId: String? = null,
)
