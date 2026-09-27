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
    // Set when the most recent refresh attempt could not reach the daemon —
    // distinct from `fetchedAt`'s age, which only says how old the last GOOD
    // fetch was. Without this, a daemon that has been down the whole time
    // renders identically to a healthy one for up to an hour: age alone
    // cannot tell "quiet because nothing changed" from "quiet because nobody
    // is answering." Cleared by touchFetchedAt/storeFresh, the two paths that
    // mean a request just succeeded.
    val lastRefreshFailed: Boolean = false,
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

    // The lock is keyed by the file's path, NOT per instance. Seven call sites
    // build their own SnapshotStore — the widget's action, the Glance provider,
    // two workers and three screens — and a per-instance lock would mean the
    // two writers that genuinely race, a WorkManager refresh and a widget tap,
    // synchronize on different objects and so not at all. Keying by path also
    // keeps unit tests in separate temp directories from contending.
    private val lock = lockFor(file)

    fun load(): Snapshot? = synchronized(lock) { loadLocked() }

    // A 304 response means the summary didn't change, but the phone still just
    // confirmed it's current — the age shown to the user should reset to zero.
    // The naive way to do that, `store.load()?.let { store.save(it.copy(...)) }`,
    // is two independently-locked transactions: a widget tap or an in-app
    // completion landing between the load and the save is blind-overwritten
    // with the pre-tap `locallyCompleted`, so the row the user just ticked
    // flickers back. This does the read and the write inside one lock instead,
    // the same fix iOS was required to make.
    fun touchFetchedAt(now: Instant = Instant.now()): Snapshot? = synchronized(lock) {
        val current = loadLocked() ?: return@synchronized null
        val touched = current.copy(fetchedAt = now, lastRefreshFailed = false)
        saveLocked(touched)
        touched
    }

    // A refresh attempt reached no daemon at all — there is no fresher summary
    // to store, but the widget and every screen's connection line still need
    // to know the last attempt did not succeed. No-ops when there is nothing
    // on disk yet: an unpaired or never-synced phone has no snapshot to mark.
    fun markRefreshFailed(): Snapshot? = synchronized(lock) {
        val current = loadLocked() ?: return@synchronized null
        if (current.lastRefreshFailed) return@synchronized current
        val marked = current.copy(lastRefreshFailed = true)
        saveLocked(marked)
        marked
    }

    // Deleting under the lock every writer for this file holds, so a refresh or an
    // optimistic completion racing a revoke cannot recreate the file with the
    // just-revoked account's tasks after it has gone.
    fun delete() {
        synchronized(lock) { file.delete() }
    }

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
    // This is a plain id-set intersection, identical to the iOS implementation.
    // Matching on anything else — a title, say — would mean a task renamed on
    // the daemon between two fetches loses its suppression and flickers back
    // under the user's finger, which is the exact bug this function exists to
    // prevent. Task ids are the daemon's stable identity; titles are not.
    fun storeFresh(summary: MobileSummary, etag: String?, now: Instant = Instant.now()): Snapshot = synchronized(lock) {
        val previous = loadLocked()
        val previouslyCompleted = previous?.locallyCompleted ?: emptySet()
        val stillOpen = summary.today.mapTo(mutableSetOf()) { it.id }
        val stillPending = previouslyCompleted.intersect(stillOpen).toMutableSet()
        val snapshot = Snapshot(summary, now, etag, stillPending, lastRefreshFailed = false)
        saveLocked(snapshot)
        snapshot
    }

    companion object {
        private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()

        // Shared by every store pointing at the same file, whoever built it.
        internal fun lockFor(file: File): Any =
            locks.computeIfAbsent(file.absolutePath) { Any() }
    }
}
