package sh.openagi.mobile.sync

import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.Snapshot
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SummaryResponse

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
    // Fired whenever this refresh wrote a new snapshot to disk — the one place
    // that repaints the widget, rather than each call site (TodayScreen,
    // Settings' "Refresh now", Pairing's first refresh) remembering to do it
    // itself and inevitably missing one. Defaults to a no-op so JVM unit tests
    // that construct this with three positional args keep compiling, and so
    // this class stays free of any Glance/Android dependency.
    private val onSnapshotChanged: suspend () -> Unit = {},
) {
    // Order matters: send what the user already did before asking what is true,
    // or a refresh will hand back the state their tap was meant to change.
    suspend fun refresh(): RefreshOutcome {
        drainQueue()
        val outcome = try {
            when (val response = client.summary(store.load()?.etag)) {
                is SummaryResponse.Unchanged -> {
                    // A single locked read-modify-write, not a load() and a
                    // separate save(): see SnapshotStore.touchFetchedAt's own
                    // comment for the lost-update race this closes.
                    store.touchFetchedAt()
                    RefreshOutcome.Unchanged
                }
                is SummaryResponse.Fresh ->
                    RefreshOutcome.Updated(store.storeFresh(response.summary, response.etag))
            }
        } catch (error: DaemonException.Unauthorized) {
            RefreshOutcome.Unauthorized
        } catch (error: Exception) {
            store.markRefreshFailed()
            RefreshOutcome.Offline
        }
        if (outcome is RefreshOutcome.Updated || outcome is RefreshOutcome.Unchanged || outcome is RefreshOutcome.Offline) {
            onSnapshotChanged()
        }
        // Best-effort: keeps the daemon's node roster showing this phone as
        // recently seen (PROTOCOL.md §8). A phone that can't be reached has
        // nothing to keep alive either, so failures here are swallowed the
        // same way an offline summary fetch already is above.
        try {
            client.heartbeat()
        } catch (error: Exception) {
            // Ignored — heartbeat is advisory, never load-bearing for this call.
        }
        return outcome
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
