package sh.openagi.mobile.ui

import sh.openagi.mobile.protocol.FleetAction
import sh.openagi.mobile.protocol.FleetCi
import sh.openagi.mobile.protocol.FleetDelivery
import sh.openagi.mobile.protocol.FleetHealth
import sh.openagi.mobile.protocol.FleetMode
import sh.openagi.mobile.protocol.FleetPr
import sh.openagi.mobile.protocol.FleetState
import sh.openagi.mobile.protocol.FleetThread
import sh.openagi.mobile.util.RelativeTime
import java.time.Instant

// Everything the Supervisor screen decides about words and order, kept pure
// so it can be pinned by tests: health order, thread names, state labels in
// plain words, PR chips and links, and what a delivery result says. The
// wording follows the /fleet web page (src/fleet/page.js) so the phone and
// the dashboard describe the same thread the same way.
object SupervisorFormat {
    // The shared supervisor thread every paired device talks in
    // (PROTOCOL.md §3.1); Chat uses "agent".
    const val THREAD = "supervisor"

    val STARTERS = listOf("What's running?", "What needs me?", "Which threads are red?")

    // Worst first: what needs a person, then what needs a look, then what is
    // fine, then what is out of scope. Within a colour, most recent first.
    val HEALTH_ORDER = listOf(FleetHealth.RED, FleetHealth.YELLOW, FleetHealth.GREEN, FleetHealth.GRAY)

    fun sorted(threads: List<FleetThread>): List<FleetThread> = threads.sortedWith(
        compareBy<FleetThread> { HEALTH_ORDER.indexOf(FleetHealth.of(it)) }
            .thenByDescending { it.lastActivityAt?.toEpochMilli() ?: Long.MIN_VALUE }
            .thenBy { name(it).lowercase() },
    )

    // "3 red · 5 yellow · 12 green", zero counts left out.
    fun summary(threads: List<FleetThread>): String {
        val counts = threads.groupingBy { FleetHealth.of(it) }.eachCount()
        return HEALTH_ORDER.mapNotNull { health -> counts[health]?.let { "$it ${health.wire}" } }.joinToString(" · ")
    }

    fun healthLabel(health: FleetHealth): String = when (health) {
        FleetHealth.RED -> "Red"
        FleetHealth.YELLOW -> "Yellow"
        FleetHealth.GREEN -> "Green"
        FleetHealth.GRAY -> "Gray"
    }

    fun name(thread: FleetThread): String =
        thread.workspace?.takeIf { it.isNotBlank() }
            ?: thread.title?.takeIf { it.isNotBlank() }
            ?: thread.key.takeIf { it.isNotBlank() }
            ?: "Untitled thread"

    fun stateLabel(state: String?): String = when (state) {
        "needs-human" -> "Needs you"
        "ready-needs-human" -> "Ready, needs a human"
        "asked-in-scope" -> "Asked, in scope"
        "pr-not-ready" -> "PR not ready"
        "infra-blocked" -> "Infra blocked"
        "local-verify" -> "Verifying on laptop"
        "waiting-ci" -> "Waiting on CI"
        "running" -> "Running"
        "idle-no-pr" -> "Idle, no PR"
        "done" -> "Done"
        "excluded" -> "Out of scope"
        null, "" -> "Unknown"
        else -> state.replace('-', ' ').replaceFirstChar { it.uppercase() }
    }

    // "Scanned 3m ago · Auto-scan on" — the header's one line of freshness.
    fun scanLine(lastTickAt: Instant?, autoScan: Boolean, now: Instant): String {
        val scanned = if (lastTickAt == null) {
            "Not scanned yet"
        } else {
            val minutes = ((now.epochSecond - lastTickAt.epochSecond) / 60).toInt()
            if (minutes <= 0) "Scanned just now" else "Scanned ${RelativeTime.short(minutes)} ago"
        }
        return scanned + if (autoScan) " · Auto-scan on" else " · Auto-scan off"
    }

    // At most one warning line: a failed last scan outranks sources that
    // could not be read, since it means nothing on screen is current.
    fun warning(state: FleetState): String? {
        state.lastErrorText?.let { return "Last scan failed: $it" }
        val failed = state.snapshot?.sourceErrorTexts?.keys.orEmpty()
        return if (failed.isEmpty()) null else "Couldn't read " + failed.sorted().joinToString(", ") + " on the last scan."
    }

    fun modeLabel(mode: String): String = when (mode) {
        FleetMode.OBSERVE -> "Observe"
        FleetMode.PROPOSE -> "Propose"
        FleetMode.AUTO -> "Auto"
        else -> mode
    }

    fun modeHint(mode: String?): String? = when (mode) {
        FleetMode.OBSERVE -> "Watching only. Sends nothing."
        FleetMode.PROPOSE -> "Plans nudges. You tap Send."
        FleetMode.AUTO -> "Sends nudges on its own, a few per scan."
        else -> null
    }

    // "owner/repo#123" -> "#123"; anything else is shown as it came.
    fun prNumber(ref: String?): String? {
        if (ref.isNullOrBlank()) return null
        return PR_REF.matchEntire(ref)?.let { "#" + it.groupValues[2] } ?: ref
    }

    fun ciLabel(ci: FleetCi?): String? {
        val state = ci?.state?.takeIf { it.isNotBlank() } ?: return null
        return when (state.uppercase()) {
            "SUCCESS" -> "CI passing"
            "FAILURE", "ERROR" -> "CI failing"
            "PENDING", "EXPECTED" -> "CI running"
            else -> "CI " + state.lowercase()
        }
    }

    fun ciFailing(ci: FleetCi?): Boolean = ci?.state?.uppercase() in setOf("FAILURE", "ERROR") || !ci?.failing.isNullOrEmpty()

    // "#123 · CI failing" — the chip on a thread row.
    fun prChip(pr: FleetPr?): String? {
        val number = prNumber(pr?.ref) ?: return null
        return listOfNotNull(number, ciLabel(pr?.ci)).joinToString(" · ")
    }

    // Only a GitHub pull request URL opens; otherwise one is built from the
    // ref, and anything else stays text — the same rule as the web page.
    fun prUrl(pr: FleetPr?): String? {
        val url = pr?.url
        if (url != null && GITHUB_PR_URL.matches(url)) return url
        val match = pr?.ref?.let { PR_REF.matchEntire(it) } ?: return null
        return "https://github.com/${match.groupValues[1]}/pull/${match.groupValues[2]}"
    }

    // Proposed nudges waiting on Send that concern this thread.
    fun proposedFor(thread: FleetThread, actions: List<FleetAction>): List<FleetAction> =
        actions.filter { it.status == "proposed" && (it.threadKey == thread.key || it.targetKey == thread.key) }

    data class Note(val text: String, val isAlert: Boolean)

    // What happened to an answer or a sent nudge, in one line.
    fun deliveryNote(delivery: FleetDelivery?, fallback: String): Note {
        val detail = delivery?.detail?.trim()?.takeIf { it.isNotEmpty() }
        return when (delivery?.status) {
            "sent" -> Note("Sent to the agent.", isAlert = false)
            "dry-run" -> Note("Saved. Dry run, nothing sent.", isAlert = false)
            "blocked" -> Note("Saved. Couldn't reach the agent" + (detail?.let { ": $it" } ?: "."), isAlert = true)
            "failed" -> Note("Saved. Send failed" + (detail?.let { ": $it" } ?: "."), isAlert = true)
            else -> Note(fallback, isAlert = false)
        }
    }

    fun errorKindLabel(kind: String?): String = when (kind) {
        "session-limit" -> "Session limit"
        "model-limit" -> "Model limit"
        "usage-limit" -> "Usage limit"
        "overloaded" -> "Provider overloaded"
        "network" -> "Network error"
        "lb" -> "Load balancer error"
        "logged-out" -> "Logged out"
        "disk-full" -> "Disk full"
        null, "" -> "Error"
        else -> kind.replace('-', ' ').replaceFirstChar { it.uppercase() }
    }

    private val PR_REF = Regex("""^([\w.-]+/[\w.-]+)#(\d+)$""")
    private val GITHUB_PR_URL = Regex("""^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$""")
}
