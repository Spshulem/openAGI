package sh.openagi.mobile.store

import kotlinx.serialization.Serializable
import sh.openagi.mobile.protocol.InstantSerializer
import sh.openagi.mobile.protocol.ProtocolJson
import java.io.File
import java.time.Instant

// One saved chat line. Kept separate from the UI's ChatEntry so the file
// format does not change every time the bubble model does.
@Serializable
data class SavedChatEntry(
    val id: Long,
    val role: String,
    @Serializable(with = InstantSerializer::class) val at: Instant,
    val text: String,
    val failed: Boolean = false,
    val failureDetail: String? = null,
    val retryText: String? = null,
    // The daemon's message id once the line is confirmed in the shared
    // thread, and the device that sent it when that was not this phone.
    val serverId: String? = null,
    val sourceName: String? = null,
)

@Serializable
private data class SavedConversation(
    val nodeId: String,
    val entries: List<SavedChatEntry>,
)

// A conversation kept on the phone so folding the phone, a process kill, or
// relaunching the app does not wipe it, and so it shows offline. The daemon's
// shared thread is the real history (PROTOCOL.md §3.1); this is only its
// cache. One file per conversation ("chat", "supervisor"), bound to the
// pairing that wrote it: a file from another node id reads as empty. Only the
// newest MAX_ENTRIES lines are kept.
class ChatHistoryStore(directory: File, key: String) {
    private val file = File(directory, "chat-$key.json")
    private val lock = lockFor(file)

    fun load(nodeId: String): List<SavedChatEntry> = synchronized(lock) {
        try {
            if (!file.exists()) return emptyList()
            val saved = ProtocolJson.json.decodeFromString(SavedConversation.serializer(), file.readText())
            if (saved.nodeId != nodeId) emptyList() else saved.entries
        } catch (error: Exception) {
            // A torn or old-format file costs the history, never the app.
            emptyList()
        }
    }

    // sequence orders writes made on different threads: one older than the
    // last write (or the last delete) is stale and dropped, so the newest
    // in-memory history always wins. A nodeId whose history was forgotten
    // is never written again, even by a reply that ends after the forget.
    fun save(nodeId: String, entries: List<SavedChatEntry>, sequence: Long = nextSequence()): Unit = synchronized(lock) {
        if (nodeId in forgotten || sequence <= (written[file.absolutePath] ?: Long.MIN_VALUE)) return@synchronized
        written[file.absolutePath] = sequence
        try {
            val kept = entries.takeLast(MAX_ENTRIES)
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(ProtocolJson.json.encodeToString(SavedConversation.serializer(), SavedConversation(nodeId, kept)))
            if (!tmp.renameTo(file)) {
                file.writeText(tmp.readText())
                tmp.delete()
            }
        } catch (error: Exception) {
            // Best-effort: a full disk loses the newest lines, not the chat.
        }
    }

    // forgetNodeId: the pairing being forgotten; its late writes are dropped.
    fun delete(forgetNodeId: String? = null) = synchronized(lock) {
        if (forgetNodeId != null) synchronized(forgotten) { forgotten.add(forgetNodeId) }
        written[file.absolutePath] = nextSequence()
        file.delete()
    }

    companion object {
        const val MAX_ENTRIES = 200
        val KEYS = listOf("chat", "supervisor")

        private val sequences = java.util.concurrent.atomic.AtomicLong()
        fun nextSequence(): Long = sequences.incrementAndGet()

        private val locks = HashMap<String, Any>()
        // Guarded by each file's lock; keyed by path.
        private val written = java.util.concurrent.ConcurrentHashMap<String, Long>()
        private val forgotten: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())

        private fun lockFor(file: File): Any = synchronized(locks) {
            locks.getOrPut(file.absolutePath) { Any() }
        }
    }
}
