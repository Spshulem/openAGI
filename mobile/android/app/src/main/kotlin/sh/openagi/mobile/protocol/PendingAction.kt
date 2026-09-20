package sh.openagi.mobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Instant

// The full approval shape from GET /pending-actions, verified live against
// the daemon in PROTOCOL.md §6. PendingActionSummary (Models.kt) is the
// trimmed shape /mobile/summary embeds; this is the detail Inbox needs so a
// person is "approving something you have actually read" (FEATURES.md).
@Serializable
data class PendingAction(
    val id: String,
    val toolName: String,
    val args: JsonElement? = null,
    val context: JsonElement? = null,
    val summary: String = "",
    val reason: String? = null,
    val dedupeKey: String? = null,
    val status: String = "pending",
    @Serializable(with = InstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = InstantSerializer::class) val expiresAt: Instant? = null,
    @Serializable(with = InstantSerializer::class) val decidedAt: Instant? = null,
    val decidedBy: String? = null,
    val result: JsonElement? = null,
    val error: String? = null,
)

@Serializable
data class PendingActionsResponse(val actions: List<PendingAction> = emptyList())

// The daemon re-invokes the original tool and returns that tool's own
// envelope on approve — PROTOCOL.md §6 is explicit there is no one fixed
// schema beyond ok/error, so `result`/`error` are read loosely rather than
// modeled per-tool.
@Serializable
data class ApprovalResult(val ok: Boolean = false, val result: JsonElement? = null, val error: String? = null)

@Serializable
data class DenyRequest(val reason: String? = null)

@Serializable
data class DenyResult(val id: String, val status: String)

// The "ask me when you can't decide" queue. GET /tasks/clarifications
// returns a bare JSON array of these, not an envelope object — see
// src/clarification-store.js's schema comment, which is authoritative here
// since PROTOCOL.md itself doesn't document this route's body shape.
@Serializable
data class Clarification(
    val id: String,
    val taskId: String,
    val question: String,
    val context: String? = null,
    val proposedAction: String? = null,
    val confidence: Double? = null,
    val sources: List<String> = emptyList(),
    val status: String = "pending",
    val answer: String? = null,
    @Serializable(with = InstantSerializer::class) val answeredAt: Instant? = null,
    @Serializable(with = InstantSerializer::class) val createdAt: Instant? = null,
)

// The daemon's clarification-store only accepts one of these four literal
// answers (src/clarification-store.js's VALID_ANSWERS) and 400s on anything
// else — FEATURES.md's "free-text answer" describes the aspiration, not
// what the route actually accepts as of this commit; see the report for the
// full note. The UI presents these four as choices, not a text field.
object ClarificationAnswer {
    const val YES = "yes"
    const val IN_PROGRESS = "in_progress"
    const val NO = "no"
    const val DROPPED = "dropped"
}

@Serializable
data class AnswerClarificationRequest(val answer: String)

@Serializable
data class AnswerClarificationResult(val clarification: Clarification, val task: Task? = null)
