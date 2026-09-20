package sh.openagi.mobile.store

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import sh.openagi.mobile.protocol.InstantSerializer
import sh.openagi.mobile.protocol.ProtocolJson
import java.io.File
import java.time.Instant
import java.util.UUID

@Serializable
data class PendingOp(
    val id: String,
    val kind: Kind,
    @Serializable(with = InstantSerializer::class) val createdAt: Instant,
    val attempts: Int = 0,
) {
    @Serializable
    sealed class Kind {
        @Serializable
        data class CompleteTask(val taskId: String) : Kind()
    }

    companion object {
        fun completeTask(taskId: String): PendingOp =
            PendingOp(UUID.randomUUID().toString(), Kind.CompleteTask(taskId), Instant.now())
    }
}

class OutboundQueue(directory: File) {
    private val file = File(directory, "outbox.json")
    private val lock = Any()

    fun all(): List<PendingOp> = synchronized(lock) { allLocked() }

    private fun allLocked(): List<PendingOp> {
        if (!file.exists()) return emptyList()
        return try {
            ProtocolJson.json.decodeFromString(ListSerializer(PendingOp.serializer()), file.readText())
        } catch (error: Exception) {
            emptyList()
        }
    }

    fun enqueue(op: PendingOp) {
        synchronized(lock) {
            val ops = allLocked()
            // Tapping the same row twice is one intent, not two.
            if (ops.any { it.kind == op.kind }) return
            writeLocked(ops + op)
        }
    }

    fun remove(id: String) {
        synchronized(lock) { writeLocked(allLocked().filterNot { it.id == id }) }
    }

    fun recordAttempt(id: String) {
        synchronized(lock) {
            val ops = allLocked().toMutableList()
            val index = ops.indexOfFirst { it.id == id }
            if (index < 0) return
            val bumped = ops[index].copy(attempts = ops[index].attempts + 1)
            // An op that has failed this many times is not going to start working.
            // Dropping it is better than a queue that retries forever on every
            // background wake.
            if (bumped.attempts >= MAX_ATTEMPTS) ops.removeAt(index) else ops[index] = bumped
            writeLocked(ops)
        }
    }

    private fun writeLocked(ops: List<PendingOp>) {
        val encoded = ProtocolJson.json.encodeToString(ListSerializer(PendingOp.serializer()), ops)
        val temp = File(file.parentFile, "outbox.json.tmp")
        temp.writeText(encoded)
        temp.renameTo(file)
    }

    companion object {
        const val MAX_ATTEMPTS = 5
    }
}
