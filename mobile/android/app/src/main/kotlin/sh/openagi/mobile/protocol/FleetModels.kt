package sh.openagi.mobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

// GET /fleet/api/state and the three mutations that return it — the fleet
// supervisor's view of every coding thread it watches (src/fleet/supervisor.js
// getState, src/fleet/routes.js). The supervisor is newer than every other
// surface here and still growing, so every field is nullable or defaulted:
// an older daemon, a first run with no scan yet, or a field renamed next week
// must degrade to an emptier screen, never to a decode failure that blanks it.
@Serializable
data class FleetState(
    val mode: String? = null,
    val enabled: Boolean = false,
    val running: Boolean = false,
    val questionsAuthoritative: Boolean = true,
    @Serializable(with = OptionalInstantSerializer::class) val lastTickAt: Instant? = null,
    // A string today; the dashboard also accepts { message }. Read loosely.
    val lastError: JsonElement? = null,
    val snapshot: FleetSnapshot? = null,
    val questions: List<FleetQuestion> = emptyList(),
    val actions: List<FleetAction> = emptyList(),
    val settings: JsonElement? = null,
) {
    val lastErrorText: String? get() = lastError.fleetText()
}

@Serializable
data class FleetSnapshot(
    @Serializable(with = OptionalInstantSerializer::class) val at: Instant? = null,
    val counts: FleetCounts = FleetCounts(),
    val threads: List<FleetThread> = emptyList(),
    val infra: JsonElement? = null,
    val sourceErrors: Map<String, JsonElement> = emptyMap(),
) {
    // Only sources that actually carry a message; an empty entry is not a failure.
    val sourceErrorTexts: Map<String, String>
        get() = sourceErrors.mapNotNull { (name, value) -> value.fleetText()?.let { name to it } }.toMap()
}

@Serializable
data class FleetCounts(
    val threads: Int = 0,
    val inScope: Int = 0,
    val byState: Map<String, Int> = emptyMap(),
    // Threads per watch group (FleetWatch.group); absent on an older daemon.
    val byWatch: Map<String, Int> = emptyMap(),
    val needsYou: Int = 0,
    val actions: Int = 0,
)

@Serializable
data class FleetThread(
    val key: String = "",
    val kind: String? = null,
    val title: String? = null,
    val workspace: String? = null,
    val repo: String? = null,
    val branch: String? = null,
    val agentStatus: String? = null,
    val state: String? = null,
    // Absent on a daemon older than the health field; FleetHealth.of falls
    // back to the same mapping the daemon uses.
    val health: String? = null,
    val reason: String? = null,
    val blockers: List<String> = emptyList(),
    val pr: FleetPr? = null,
    @Serializable(with = OptionalInstantSerializer::class) val lastActivityAt: Instant? = null,
    val lastAgentText: String? = null,
    val error: FleetThreadError? = null,
    val live: Boolean = false,
    val route: String? = null,
    val decision: FleetDecision? = null,
    val pushPreview: FleetDecision? = null,
    val pushing: Boolean = false,
    // When the agent last said something, as opposed to any activity.
    @Serializable(with = OptionalInstantSerializer::class) val lastAgentAt: Instant? = null,
    // What the supervisor is watching this thread for, and since when. Null
    // for an out-of-scope thread, and on every thread from an older daemon.
    val watch: FleetWatch? = null,
    // What opens this exact chat, and until when the owner muted it.
    val openChat: FleetOpenChat? = null,
    @Serializable(with = OptionalInstantSerializer::class) val muted: Instant? = null,
    // The owner's own last message in the chat; the supervisor's are not his.
    @Serializable(with = OptionalInstantSerializer::class) val lastOwnerAt: Instant? = null,
)

// GET /fleet/api/threads/:key — one row expanded: the agent's last message
// (a longer excerpt than the row's), the owner's last word, the questions
// open about it, and when the scan it comes from ran.
@Serializable
data class FleetThreadDetailResult(val thread: FleetThreadDetail? = null)

@Serializable
data class FleetThreadDetail(
    val key: String = "",
    val kind: String? = null,
    val title: String? = null,
    val workspace: String? = null,
    val repo: String? = null,
    val branch: String? = null,
    val app: String? = null,
    val agentStatus: String? = null,
    val live: Boolean = false,
    val state: String? = null,
    val health: String? = null,
    val reason: String? = null,
    val blockers: List<String> = emptyList(),
    val error: FleetThreadError? = null,
    val lastAgentMessage: FleetAgentMessage? = null,
    @Serializable(with = OptionalInstantSerializer::class) val lastOwnerAt: Instant? = null,
    @Serializable(with = OptionalInstantSerializer::class) val lastActivityAt: Instant? = null,
    val pr: FleetPr? = null,
    val watch: FleetWatch? = null,
    val decision: FleetDecision? = null,
    val pushPreview: FleetDecision? = null,
    val pushing: Boolean = false,
    @Serializable(with = OptionalInstantSerializer::class) val muted: Instant? = null,
    val questions: List<FleetQuestion> = emptyList(),
    val openChat: FleetOpenChat? = null,
    @Serializable(with = OptionalInstantSerializer::class) val scannedAt: Instant? = null,
)

// The last 1200 characters, secrets already redacted by the daemon.
@Serializable
data class FleetAgentMessage(
    val text: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val at: Instant? = null,
)

// src/fleet/contracts.js openChatFor. url is the Mac app's own link
// (conductor://workspace?..., codex://threads/<id>), null when no link opens
// the chat; label names the workspace or folder, the chat and the app
// ("remote-dev · Codex LB Transcript open (Conductor)"); note says why
// there is no link.
@Serializable
data class FleetOpenChat(
    val app: String? = null,
    val url: String? = null,
    val label: String? = null,
    val note: String? = null,
)

// One chat of a grouped question.
@Serializable
data class FleetQuestionChat(
    val threadKey: String? = null,
    val app: String? = null,
    val url: String? = null,
    val label: String? = null,
    val note: String? = null,
) {
    val openChat: FleetOpenChat get() = FleetOpenChat(app, url, label, note)
}

// src/fleet/classify.js watchOf, kept across scans by the supervisor:
// group is one of FleetWatchGroup; since is when the thread entered it;
// waitingOn names what a "waiting" thread waits on ("BuildBot3 full run");
// waitSince is how long its wait has been going; runningSince is when the
// agent's current turn started.
@Serializable
data class FleetWatch(
    val group: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val since: Instant? = null,
    val waitingOn: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val waitSince: Instant? = null,
    @Serializable(with = OptionalInstantSerializer::class) val runningSince: Instant? = null,
    // On a "you" row: the group it returns to once its question closes.
    val otherwise: FleetWatchOtherwise? = null,
)

@Serializable
data class FleetWatchOtherwise(val group: String? = null, val waitingOn: String? = null)

// A thread whose PR the supervisor could not read still carries its ref, with
// url/state null — the same partial shape buildSnapshot emits.
@Serializable
data class FleetPr(
    val ref: String? = null,
    val url: String? = null,
    val state: String? = null,
    val title: String? = null,
    val ci: FleetCi? = null,
    val unresolvedThreads: Int? = null,
    val mergeState: String? = null,
    val head: String? = null,
)

@Serializable
data class FleetCi(
    val state: String? = null,
    val failing: List<String> = emptyList(),
    val pending: List<String> = emptyList(),
)

@Serializable
data class FleetThreadError(
    val kind: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val resetAt: Instant? = null,
)

@Serializable
data class FleetDecision(
    val action: String? = null,
    val playbook: String? = null,
    val reason: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val notBefore: Instant? = null,
    // The words Push now would send; null when nothing is planned to be sent.
    val message: String? = null,
)

@Serializable
data class FleetQuestion(
    val id: String = "",
    val title: String? = null,
    val body: String? = null,
    val options: List<String> = emptyList(),
    val kind: String? = null,
    val threadKey: String? = null,
    val threadKeys: List<String>? = null,
    val prRef: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val createdAt: Instant? = null,
    // When the agent asked (else when the supervisor first asked), in which
    // chat, and whether the answer can be given here or only in the agent's
    // app ("here" or "agent app").
    @Serializable(with = OptionalInstantSerializer::class) val askedAt: Instant? = null,
    val chatLabel: String? = null,
    val answerIn: String? = null,
    val openChat: FleetOpenChat? = null,
    // Grouped questions only: each of its chats.
    val chats: List<FleetQuestionChat> = emptyList(),
    // A merge, release, deploy, delete or force-push: the full text is read
    // before any button.
    val risky: Boolean = false,
    // The agent message the ask came from.
    val askContext: String? = null,
) {
    val answeredInAgentApp: Boolean get() = answerIn == "agent app" || (answerIn == null && "open thread" in options)
}

@Serializable
data class FleetAction(
    val id: String = "",
    val status: String? = null,
    val playbook: String? = null,
    val threadKey: String? = null,
    val targetKey: String? = null,
    val message: String? = null,
    val reason: String? = null,
    val detail: String? = null,
    @Serializable(with = OptionalInstantSerializer::class) val at: Instant? = null,
)

// How an answer or a proposed nudge reached (or failed to reach) the agent:
// status is "sent", "blocked" or "failed" (src/fleet/executor.js).
@Serializable
data class FleetDelivery(val status: String? = null, val route: String? = null, val detail: String? = null)

// POST /fleet/api/threads/:key/push. A refusal is a "blocked" delivery whose
// detail says why; action is the recorded send, by "owner".
@Serializable
data class FleetPushResult(
    val delivery: FleetDelivery? = null,
    val action: FleetAction? = null,
    val state: FleetState? = null,
)

// POST /fleet/api/threads/:key/mute and /unmute: until when, or null.
@Serializable
data class FleetMuteResult(
    @Serializable(with = OptionalInstantSerializer::class) val muted: Instant? = null,
    val state: FleetState? = null,
)

@Serializable
data class FleetMuteRequest(val hours: Int)

// POST /fleet/api/questions/:id. A dismissal carries no delivery.
@Serializable
data class FleetQuestionResult(
    val question: FleetQuestion? = null,
    val delivery: FleetDelivery? = null,
    val state: FleetState? = null,
)

// POST /fleet/api/actions/:id/send.
@Serializable
data class FleetActionResult(
    val action: FleetAction? = null,
    val delivery: FleetDelivery? = null,
    val state: FleetState? = null,
)

@Serializable
data class FleetModeRequest(val mode: String)

@Serializable
data class FleetAnswerRequest(val answer: String)

@Serializable
data class FleetDismissRequest(val dismiss: Boolean = true)

object FleetMode {
    const val OBSERVE = "observe"
    const val PROPOSE = "propose"
    const val AUTO = "auto"
    val ALL = listOf(OBSERVE, PROPOSE, AUTO)
}

// The contract's four colours. The daemon sends `health` on every thread;
// the fallback below is the same table, for a daemon that does not yet.
enum class FleetHealth(val wire: String) {
    RED("red"),
    YELLOW("yellow"),
    GREEN("green"),
    GRAY("gray");

    companion object {
        private val GREEN_STATES = setOf("running", "waiting-ci", "local-verify", "asked-in-scope", "done")
        private val YELLOW_STATES = setOf("pr-not-ready", "idle-no-pr", "ready-needs-human")
        private val RED_STATES = setOf("needs-human", "infra-blocked")

        fun of(thread: FleetThread): FleetHealth =
            entries.firstOrNull { it.wire == thread.health } ?: fallback(thread.state, thread.error != null)

        // Same order as the daemon's threadHealth (src/fleet/classify.js):
        // excluded or unknown is gray even with an error, since nothing
        // about it is known to be waiting on anyone; then an error outside
        // a running turn is red; then the state decides.
        fun fallback(state: String?, hasError: Boolean): FleetHealth = when {
            state == null || state !in GREEN_STATES + YELLOW_STATES + RED_STATES -> GRAY
            hasError && state != "running" -> RED
            state in RED_STATES -> RED
            state in YELLOW_STATES -> YELLOW
            else -> GREEN
        }
    }
}

// The supervisor's JSON is read with its own instance: on top of
// ProtocolJson's ignoreUnknownKeys, coerceInputValues turns an explicit null
// in a defaulted field (a list, a count) into that default instead of an
// exception — the "partial data never crashes" half of the contract.
object FleetJson {
    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        coerceInputValues = true
    }
}

private fun JsonElement?.fleetText(): String? = when (this) {
    null, JsonNull -> null
    is JsonPrimitive -> content.takeIf { it.isNotBlank() }
    is JsonObject -> (this["message"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
    else -> null
}
