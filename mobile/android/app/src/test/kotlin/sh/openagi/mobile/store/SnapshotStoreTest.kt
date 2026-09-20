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

    // The id is derived from the title, not from the position in the list. A
    // positional id makes summary("A","B") and summary("B") both call their
    // first item task_0, so "the server dropped A" is indistinguishable from
    // "the server renamed task_0 to B" — an artifact of the helper that a real
    // daemon never produces, since its ids are stable per task.
    private fun summary(vararg titles: String): MobileSummary {
        val today = titles.map { title ->
            TaskItem(id = "task_${title.lowercase()}", title = title, bucket = "today", status = "pending",
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
        val updated = store().applyOptimisticCompletion("task_a")!!
        assertEquals(listOf("B"), updated.visibleToday.map { it.title })
        assertEquals(1, updated.visibleCounts.today)
        // And it survives a reload, because the widget may read from a cold start.
        assertEquals(listOf("B"), store().load()!!.visibleToday.map { it.title })
    }

    @Test
    fun aFreshFetchDropsOptimisticIdsTheServerNoLongerLists() {
        store().save(Snapshot(summary("A", "B"), Instant.now(), null, emptySet()))
        store().applyOptimisticCompletion("task_a")
        // Server still lists task_a: keep hiding it, the completion is in flight.
        store().storeFresh(summary("A", "B"), null)
        assertEquals(listOf("B"), store().load()!!.visibleToday.map { it.title })
        assertEquals(setOf("task_a"), store().load()!!.locallyCompleted)
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

    @Test
    fun touchFetchedAtResetsAgeWithoutTouchingOtherFields() {
        val old = Instant.now().minusSeconds(900)
        store().save(Snapshot(summary("A", "B"), old, "\"e1\"", setOf("task_a")))
        val touched = store().touchFetchedAt(Instant.now())!!
        assertEquals(0, touched.ageInMinutes())
        assertEquals("\"e1\"", touched.etag)
        assertEquals(setOf("task_a"), touched.locallyCompleted)
    }

    @Test
    fun touchFetchedAtOnAMissingSnapshotIsNullNotAThrow() {
        assertNull(store().touchFetchedAt())
    }

    // The bug this guards against: a 304 handler that does
    // `store.load()?.let { store.save(it.copy(fetchedAt = now)) } }` is two
    // independently-locked transactions, so a completion landing in the gap
    // between them is silently overwritten with the pre-completion
    // `locallyCompleted` set — the row the user just ticked flickers back.
    // touchFetchedAt does the read and the write under one lock instead, so
    // hammering it concurrently with real completions must never lose one.
    @Test
    fun touchFetchedAtNeverLosesAConcurrentCompletion() {
        store().save(Snapshot(summary("A", "B"), Instant.now(), null, emptySet()))
        val touchers = List(8) {
            Thread {
                repeat(200) { store().touchFetchedAt() }
            }
        }
        val completer = Thread { store().applyOptimisticCompletion("task_a") }
        (touchers + completer).forEach { it.start() }
        (touchers + completer).forEach { it.join() }
        assertEquals(setOf("task_a"), store().load()!!.locallyCompleted)
    }
}
