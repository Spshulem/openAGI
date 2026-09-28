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
)

@Serializable
private data class SavedConversation(
    val nodeId: String,
    val entries: List<SavedChatEntry>,
)

// A conversation kept on the phone so folding the phone, a process kill, or
// relaunching the app does not wipe it. One file per conversation ("chat",
// "supervisor"), bound to the pairing that wrote it: a file from another
// node id reads as empty. Only the newest MAX_ENTRIES lines are kept.
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

    fun save(nodeId: String, entries: List<SavedChatEntry>) = synchronized(lock) {
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

    fun delete() = synchronized(lock) {
        file.delete()
    }

    companion object {
        const val MAX_ENTRIES = 200
        val KEYS = listOf("chat", "supervisor")

        private val locks = HashMap<String, Any>()

        private fun lockFor(file: File): Any = synchronized(locks) {
            locks.getOrPut(file.absolutePath) { Any() }
        }
    }
}
