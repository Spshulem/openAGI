package sh.openagi.mobile.store

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import sh.openagi.mobile.protocol.ProtocolJson
import java.io.File

// The supervisor question ids this phone has already posted a notification
// for. It is what makes a ping happen once per question rather than once per
// check, and what says which notifications to take down when a question
// closes. Oldest first, so the cap below drops the stalest ids.
class NotifiedQuestionsStore(directory: File) {
    private val file = File(directory, FILE_NAME)

    // Keyed by path, not per instance — see SnapshotStore.lockFor. The live
    // alerts service, RefreshWorker and an answer worker each build their own
    // store over this file and can write in the same second.
    private val lock = SnapshotStore.lockFor(file)

    fun load(): Set<String> = synchronized(lock) { loadLocked() }

    fun replace(ids: Set<String>) {
        synchronized(lock) { writeLocked(ids.toList()) }
    }

    fun add(id: String) {
        if (id.isBlank()) return
        synchronized(lock) {
            val ids = loadLocked()
            if (id in ids) return
            writeLocked(ids.toList() + id)
        }
    }

    fun remove(id: String) {
        synchronized(lock) {
            val ids = loadLocked()
            if (id !in ids) return
            writeLocked(ids.toList() - id)
        }
    }

    // Forgetting a pairing must also forget what it was told about: the next
    // daemon's questions are all new to this phone.
    fun clear() {
        synchronized(lock) { file.delete() }
    }

    private fun loadLocked(): LinkedHashSet<String> {
        if (!file.exists()) return LinkedHashSet()
        return try {
            ProtocolJson.json.decodeFromString(ListSerializer(String.serializer()), file.readText())
                .filterTo(LinkedHashSet()) { it.isNotBlank() }
        } catch (error: Exception) {
            // A half-written or foreign file costs at most one repeat ping per
            // open question, which beats failing every check from here on.
            LinkedHashSet()
        }
    }

    private fun writeLocked(ids: List<String>) {
        // A question whose close this phone never saw (it was off that day)
        // would otherwise stay here for good.
        val capped = ids.filter { it.isNotBlank() }.distinct().takeLast(MAX_IDS)
        val encoded = ProtocolJson.json.encodeToString(ListSerializer(String.serializer()), capped)
        // Atomic: a reader in another worker must never see half a file.
        val temp = File(file.parentFile, "$FILE_NAME.tmp")
        temp.writeText(encoded)
        temp.renameTo(file)
    }

    companion object {
        const val FILE_NAME = "supervisor-notified.json"
        const val MAX_IDS = 200
    }
}
