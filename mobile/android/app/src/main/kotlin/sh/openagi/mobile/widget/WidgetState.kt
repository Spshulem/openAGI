package sh.openagi.mobile.widget

import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Snapshot
import java.time.Instant

sealed class WidgetState {
    object Unpaired : WidgetState()
    data class Empty(val headline: String) : WidgetState()
    data class Tasks(val items: List<TaskItem>, val counts: Counts, val ageMinutes: Int) : WidgetState()
    data class Stale(val ageMinutes: Int) : WidgetState()

    // The last refresh attempt did not reach the daemon. Distinct from Stale:
    // Stale is purely an age judgement ("we haven't heard in a while, we don't
    // know why"); Unreachable is a fact we actually have ("we just tried and
    // failed"), which can be true well inside the 60-minute staleness window.
    // Without this case a daemon that has been down the whole time renders
    // identically to a healthy one until the age crosses STALE_AFTER_MINUTES.
    // Still shows the last-known tasks — DESIGN.md: "every screen renders from
    // the last snapshot when the daemon is unreachable" — just labelled
    // honestly instead of claiming the row list is current.
    data class Unreachable(val items: List<TaskItem>, val counts: Counts, val ageMinutes: Int) : WidgetState()

    companion object {
        // Past this, old rows stop being information and start being a lie.
        const val STALE_AFTER_MINUTES = 60

        fun from(snapshot: Snapshot?, paired: Boolean, now: Instant = Instant.now()): WidgetState {
            if (!paired) return Unpaired
            if (snapshot == null) return Empty("Open OpenAGI to sync")
            val age = snapshot.ageInMinutes(now)
            if (snapshot.lastRefreshFailed) return Unreachable(snapshot.visibleToday, snapshot.visibleCounts, age)
            if (age > STALE_AFTER_MINUTES) return Stale(age)
            val visible = snapshot.visibleToday
            if (visible.isEmpty()) return Empty(snapshot.summary.brief.headline.ifEmpty { "Nothing due today" })
            return Tasks(visible, snapshot.visibleCounts, age)
        }
    }
}
