package sh.openagi.mobile.protocol

import kotlinx.serialization.Serializable
import java.time.Instant

// Body for POST /message. PROTOCOL.md §3 and src/hosted-interface.js's
// node-message allowlist both limit a node-authenticated caller (a phone is
// always one) to exactly these four fields — sending anything else 400s.
@Serializable
data class SendMessageRequest(
    val text: String,
    val from: String? = null,
    val sessionId: String? = null,
    // "agent" or "supervisor": the shared thread every paired device talks
    // in (PROTOCOL.md §3.1). With it the daemon ignores from and sessionId.
    val thread: String? = null,
    // This phone's own name for the turn (PROTOCOL.md §3.1 "Recovering a
    // turn"): sending it again never runs the turn twice. Omitted when null.
    val requestId: String? = null,
)

// GET /conversations/:thread/messages (PROTOCOL.md §3.1). Oldest first; user
// and assistant text only. sourceNodeId/sourceName say which paired device
// sent a user message and are null on replies.
@Serializable
data class ConversationMessage(
    val id: String,
    val role: String,
    val text: String,
    @Serializable(with = InstantSerializer::class) val at: Instant,
    val sourceNodeId: String? = null,
    val sourceName: String? = null,
    // The turn this line belongs to; a phone matches its own send and the
    // reply to it by this. "failed" marks main's stored failure record.
    val requestId: String? = null,
    val status: String? = null,
)

// A turn main is still running in the thread with no client attached.
@Serializable
data class InFlightTurn(val requestId: String, val stage: String? = null, val startedAt: String? = null)

@Serializable
data class ConversationPage(
    val thread: String,
    val messages: List<ConversationMessage> = emptyList(),
    // The `before` cursor for the next older page; null at the thread's start.
    val nextBefore: String? = null,
    // Turns still running (newest page only). Null from a main older than
    // turn recovery, which cannot say.
    val inFlight: List<InFlightTurn>? = null,
)

// The /events frame that says a shared thread has a new stored message.
@Serializable
data class ConversationUpdated(val thread: String, val messageId: String? = null)

// The frames streamLocalMessage (src/hosted-interface.js) writes when a
// POST /message call carries `Accept: text/event-stream`. This is the real
// mechanism FEATURES.md's "stream the reply... rendering tokens as they
// arrive" describes — see the report for why that isn't GET /events, which
// never carries chat text at all.
@Serializable
data class ChatStatusPayload(val stage: String = "", val sessionId: String? = null)

@Serializable
data class ChatSessionPayload(val id: String, val messageCount: Int = 0, val agent: String? = null)

@Serializable
data class ChatDeltaPayload(val text: String = "", val reset: Boolean = false, val sessionId: String? = null)

@Serializable
data class ChatSessionInfo(val id: String, val messageCount: Int = 0)

// The exact object the non-streaming JSON endpoint also returns —
// src/agent-host.js's handleMessageNow: { id, createdAt, agent, session,
// reply, model, output }. Only the fields the chat screen renders are
// modeled; ignoreUnknownKeys drops the rest.
@Serializable
data class ChatFinalPayload(val reply: String = "", val session: ChatSessionInfo? = null)

@Serializable
data class ChatFailurePayload(val error: String = "", val code: String? = null, val sessionId: String? = null)
