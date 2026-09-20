package sh.openagi.mobile.sync

import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.Snapshot
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SummaryResponse
import java.time.Instant

sealed class RefreshOutcome {
    data class Updated(val snapshot: Snapshot) : RefreshOutcome()
    object Unchanged : RefreshOutcome()
    object Unauthorized : RefreshOutcome()
    object Offline : RefreshOutcome()
}

class RefreshCoordinator(
    private val client: DaemonClient,
    private val store: SnapshotStore,
    private val queue: OutboundQueue,
) {
    // Order matters: send what the user already did before asking what is true,
    // or a refresh will hand back the state their tap was meant to change.
    suspend fun refresh(): RefreshOutcome {
        drainQueue()
        return try {
            when (val response = client.summary(store.load()?.etag)) {
                is SummaryResponse.Unchanged -> {
                    store.load()?.let { store.save(it.copy(fetchedAt = Instant.now())) }
                    RefreshOutcome.Unchanged
                }
                is SummaryResponse.Fresh ->
                    RefreshOutcome.Updated(store.storeFresh(response.summary, response.etag))
            }
        } catch (error: DaemonException.Unauthorized) {
            RefreshOutcome.Unauthorized
        } catch (error: Exception) {
            RefreshOutcome.Offline
        }
    }

    suspend fun drainQueue() {
        queue.all().forEach { op ->
            when (val kind = op.kind) {
                is PendingOp.Kind.CompleteTask -> try {
                    client.complete(kind.taskId)
                    queue.remove(op.id)
                } catch (error: DaemonException.NotFound) {
                    // The server has already moved on. Replaying cannot help.
                    queue.remove(op.id)
                } catch (error: DaemonException.Conflict) {
                    queue.remove(op.id)
                } catch (error: Exception) {
                    queue.recordAttempt(op.id)
                }
            }
        }
    }
}
