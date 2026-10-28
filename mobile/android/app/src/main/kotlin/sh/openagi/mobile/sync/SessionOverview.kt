package sh.openagi.mobile.sync

import sh.openagi.mobile.protocol.FleetState
import sh.openagi.mobile.protocol.FleetThread
import java.time.Duration
import java.time.Instant

// Mirrors the daemon's encrypted iOS activity projection. No Android APIs:
// one fresh snapshot determines all counts and the exact session to open.
data class SessionOverview(
    val needsYou: Int,
    val working: Int,
    val waiting: Int,
    val blocked: Int,
    val first: FleetThread?,
    val observedAt: Instant?,
    val partial: Boolean,
) {
    val active: Boolean get() = needsYou + working + waiting + blocked > 0
    val countsLine: String get() = listOfNotNull(
        needsYou.takeIf { it > 0 }?.let { "$it needs you" },
        blocked.takeIf { it > 0 }?.let { "$it blocked" },
        working.takeIf { it > 0 }?.let { "$it working" },
        waiting.takeIf { it > 0 }?.let { "$it waiting" },
    ).joinToString(" · ").ifEmpty { "No active sessions" }
    val chip: String get() = when {
        needsYou > 0 -> "$needsYou need"
        blocked > 0 -> "$blocked held"
        working > 0 -> "$working run"
        else -> "$waiting wait"
    }
    val detail: String? get() = first?.let { thread ->
        val title = thread.title?.trim().takeUnless { it.isNullOrEmpty() } ?: thread.key
        val reason = thread.watch?.waitingOn?.takeIf { it.isNotBlank() }
            ?: if (thread.watch?.group == "blocked") thread.reason ?: thread.blockers.firstOrNull() else null
        listOfNotNull(title, reason).joinToString(" — ").let { SupervisorAlerts.cap(it, 180) }
    }

    fun stale(now: Instant): Boolean = observedAt == null || Duration.between(observedAt, now).toMinutes() >= 30

    fun title(now: Instant, offline: Boolean): String = when {
        offline -> "Can't reach server · Last known sessions"
        stale(now) -> "Session updates paused"
        else -> countsLine
    }

    fun body(now: Instant, offline: Boolean): String {
        val age = observedAt?.let { "Last scan ${Duration.between(it, now).toMinutes().coerceAtLeast(0)}m ago" } ?: "No scan received yet"
        return listOfNotNull(
            if (offline || stale(now)) countsLine else detail,
            if (partial) "Some sessions unavailable" else null,
            age,
        ).joinToString(" · ")
    }

    companion object {
        private val groups = listOf("you", "blocked", "working", "waiting")
        fun from(state: FleetState): SessionOverview {
            val sessions = state.snapshot?.threads.orEmpty()
                .filter { it.key.isNotBlank() && it.watch?.group in groups }
                .distinctBy { it.key }
                .sortedWith(compareBy<FleetThread> { groups.indexOf(it.watch?.group) }
                    .thenByDescending { it.watch?.since ?: Instant.MIN })
            fun count(group: String) = sessions.count { it.watch?.group == group }
            return SessionOverview(count("you"), count("working"), count("waiting"), count("blocked"), sessions.firstOrNull(),
                state.snapshot?.at ?: state.lastTickAt, state.lastErrorText != null || state.snapshot?.sourceErrorTexts?.isNotEmpty() == true)
        }
    }
}
