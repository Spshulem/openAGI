package sh.openagi.mobile.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.Brief
import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Snapshot
import java.time.Instant

class WidgetStateTest {
    private val now: Instant = Instant.parse("2026-09-19T12:00:00Z")

    private fun snapshot(titles: List<String>, minutesAgo: Long, completed: Set<String> = emptySet()): Snapshot {
        val today = titles.mapIndexed { index, title ->
            TaskItem("task_$index", title, "today", "pending", 50, null, false)
        }
        return Snapshot(
            summary = MobileSummary(
                generatedAt = now.minusSeconds(minutesAgo * 60),
                today = today,
                counts = Counts(today.size, 0, 0, 0),
                pendingActions = emptyList(),
                brief = Brief("${today.size} things today"),
            ),
            fetchedAt = now.minusSeconds(minutesAgo * 60),
            etag = null,
            locallyCompleted = completed,
        )
    }

    @Test
    fun noCredentialsMeansUnpaired() {
        assertEquals(WidgetState.Unpaired, WidgetState.from(snapshot(listOf("A"), 1), paired = false, now = now))
    }

    @Test
    fun pairedWithNoSnapshotMeansEmpty() {
        val state = WidgetState.from(null, paired = true, now = now)
        assertTrue(state is WidgetState.Empty)
        assertTrue((state as WidgetState.Empty).headline.isNotEmpty())
    }

    @Test
    fun freshSnapshotRendersTasksWithTheirAge() {
        val state = WidgetState.from(snapshot(listOf("A", "B"), 3), paired = true, now = now) as WidgetState.Tasks
        assertEquals(listOf("A", "B"), state.items.map { it.title })
        assertEquals(3, state.ageMinutes)
    }

    @Test
    fun pastAnHourTheWidgetSaysItIsStaleRatherThanLying() {
        // Past an hour the widget must say so rather than present old rows as current.
        val state = WidgetState.from(snapshot(listOf("A", "B"), 61), paired = true, now = now)
        assertEquals(WidgetState.Stale(61), state)
    }

    @Test
    fun anOptimisticallyCompletedOnlyTaskLeavesTheWidgetEmpty() {
        val state = WidgetState.from(snapshot(listOf("A"), 2, completed = setOf("task_0")), paired = true, now = now)
        assertTrue(state is WidgetState.Empty)
    }

    // iOS's own review flagged this exact gap: no test at ageMinutes == 60, so a
    // `>` vs `>=` mutation at the staleness boundary would go uncaught. At
    // exactly the threshold the data is still current, not stale — only past it
    // does the widget refuse to show old rows as current.
    @Test
    fun atExactlySixtyMinutesTheSnapshotIsStillFreshNotStale() {
        // The other side of the boundary from pastAnHourTheWidgetSaysItIsStaleRatherThanLying
        // (61 minutes): at exactly 60 the data is still current, so this must
        // remain Tasks, not Stale. A `>=` mutation at the threshold would flip
        // this to Stale and only the >61 test would still pass.
        val state = WidgetState.from(snapshot(listOf("A", "B"), 60), paired = true, now = now)
        assertTrue(state is WidgetState.Tasks)
        assertEquals(60, (state as WidgetState.Tasks).ageMinutes)
    }
}
