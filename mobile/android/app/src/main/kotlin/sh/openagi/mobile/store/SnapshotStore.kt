package sh.openagi.mobile.store

import kotlinx.serialization.Serializable
import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.InstantSerializer
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.protocol.TaskItem
import java.io.File
import java.time.Instant
import kotlin.math.max

@Serializable
data class Snapshot(
    val summary: MobileSummary,
    @Serializable(with = InstantSerializer::class) val fetchedAt: Instant,
    val etag: String? = null,
    val locallyCompleted: Set<String> = emptySet(),
) {
    // What the UI and widget actually draw: the server's list minus anything
    // completed here that the server has not caught up with yet.
    val visibleToday: List<TaskItem>
        get() = summary.today.filter { it.id !in locallyCompleted }

    val visibleCounts: Counts
        get() {
            val hidden = summary.today.filter { it.id in locallyCompleted }
            return Counts(
                today = max(0, summary.counts.today - hidden.size),
                thisWeek = summary.counts.thisWeek,
                overdue = max(0, summary.counts.overdue - hidden.count { it.overdue }),
                pendingActions = summary.counts.pendingActions,
            )
        }

    fun ageInMinutes(now: Instant = Instant.now()): Int =
        max(0, ((now.epochSecond - fetchedAt.epochSecond) / 60).toInt())
}

class SnapshotStore(directory: File) {
    private val file = File(directory, "snapshot.json")
    private val lock = Any()

    fun load(): Snapshot? = synchronized(lock) { loadLocked() }

    private fun loadLocked(): Snapshot? {
        if (!file.exists()) return null
        return try {
            ProtocolJson.json.decodeFromString(Snapshot.serializer(), file.readText())
        } catch (error: Exception) {
            // A half-written or stale-format file is not worth crashing a widget over.
            null
        }
    }

    fun save(snapshot: Snapshot) {
        synchronized(lock) { saveLocked(snapshot) }
    }

    private fun saveLocked(snapshot: Snapshot) {
        val encoded = ProtocolJson.json.encodeToString(Snapshot.serializer(), snapshot)
        // Atomic: a widget reading mid-write must never see half a file.
        val temp = File(file.parentFile, "snapshot.json.tmp")
        temp.writeText(encoded)
        temp.renameTo(file)
    }

    fun applyOptimisticCompletion(taskId: String): Snapshot? = synchronized(lock) {
        val current = loadLocked() ?: return@synchronized null
        val updated = current.copy(locallyCompleted = current.locallyCompleted + taskId)
        saveLocked(updated)
        updated
    }

    // Called after a successful fetch: keep only the optimistic ids the server
    // still lists as open, so the set cannot grow forever. Both directions
    // matter: an id the user optimistically completed must stop being
    // suppressed once the server agrees it is done (dropped here), and an id
    // the server still reports open must stay suppressed (kept here).
    //
    // A plain id-set intersection is not enough: it only asks "is this id
    // still present in the new fetch", and cannot tell apart "the same task
    // is still open" from "this id now happens to label an unrelated task".
    // Real daemon ids never get reassigned to a different task, so this only
    // bites in a coincidence, but the cost of getting it wrong is a task that
    // never reappears — so we also require the title to still match before
    // continuing to suppress an id.
    fun storeFresh(summary: MobileSummary, etag: String?, now: Instant = Instant.now()): Snapshot = synchronized(lock) {
        val previous = loadLocked()
        val previouslyCompleted = previous?.locallyCompleted ?: emptySet()
        val previousById = previous?.summary?.today?.associateBy { it.id } ?: emptyMap()
        val newById = summary.today.associateBy { it.id }
        val stillPending = previouslyCompleted.filterTo(mutableSetOf()) { id ->
            val newItem = newById[id] ?: return@filterTo false
            val oldItem = previousById[id]
            oldItem == null || oldItem.title == newItem.title
        }
        val snapshot = Snapshot(summary, now, etag, stillPending)
        saveLocked(snapshot)
        snapshot
    }
}
