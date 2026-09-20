package sh.openagi.mobile.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sh.openagi.mobile.protocol.Brief
import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.TaskItem
import java.io.File
import java.time.Instant

class SnapshotStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private fun summary(vararg titles: String): MobileSummary {
        val today = titles.mapIndexed { index, title ->
            TaskItem(id = "task_$index", title = title, bucket = "today", status = "pending",
                     priority = 50, dueDate = null, overdue = false)
        }
        return MobileSummary(
            generatedAt = Instant.now(),
            today = today,
            counts = Counts(today = today.size, thisWeek = 0, overdue = 0, pendingActions = 0),
            pendingActions = emptyList(),
            brief = Brief("${today.size} things today"),
        )
    }

    private fun store(): SnapshotStore = SnapshotStore(folder.root)

    @Test
    fun roundTrips() {
        assertNull(store().load())
        store().save(Snapshot(summary("A", "B"), Instant.now(), "\"x\"", emptySet()))
        val loaded = store().load()
        assertNotNull(loaded)
        assertEquals(listOf("A", "B"), loaded!!.summary.today.map { it.title })
        assertEquals("\"x\"", loaded.etag)
    }

    @Test
    fun optimisticCompletionHidesTheTaskImmediately() {
        store().save(Snapshot(summary("A", "B"), Instant.now(), null, emptySet()))
        val updated = store().applyOptimisticCompletion("task_0")!!
        assertEquals(listOf("B"), updated.visibleToday.map { it.title })
        assertEquals(1, updated.visibleCounts.today)
        // And it survives a reload, because the widget may read from a cold start.
        assertEquals(listOf("B"), store().load()!!.visibleToday.map { it.title })
    }

    @Test
    fun aFreshFetchDropsOptimisticIdsTheServerNoLongerLists() {
        store().save(Snapshot(summary("A", "B"), Instant.now(), null, emptySet()))
        store().applyOptimisticCompletion("task_0")
        // Server still lists task_0: keep hiding it, the completion is in flight.
        store().storeFresh(summary("A", "B"), null)
        assertEquals(listOf("B"), store().load()!!.visibleToday.map { it.title })
        assertEquals(setOf("task_0"), store().load()!!.locallyCompleted)
        // Server has caught up: the optimistic set must not grow forever.
        store().storeFresh(summary("B"), null)
        assertEquals(emptySet<String>(), store().load()!!.locallyCompleted)
    }

    @Test
    fun corruptFileIsTreatedAsNoSnapshotRatherThanCrashing() {
        File(folder.root, "snapshot.json").writeText("not json")
        assertNull(store().load())
    }

    @Test
    fun stalenessIsComputable() {
        val old = Instant.now().minusSeconds(900)
        store().save(Snapshot(summary("A"), old, null, emptySet()))
        assertEquals(15, store().load()!!.ageInMinutes(now = old.plusSeconds(900)))
    }
}
