package sh.openagi.mobile.sync

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.widget.TodayWidget

// Fired right after a widget tap queues a completion, so the daemon hears
// about it within seconds instead of waiting for RefreshWorker's next
// 15-minute tick. Drains the outbox only -- it does not also fetch a fresh
// summary, so one tap does not silently trigger a second, unrelated refresh.
class DrainWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val credentials = Credentials.load(applicationContext) ?: return Result.success()
        val coordinator = RefreshCoordinator(
            DaemonClient(credentials.server, credentials.nodeId, credentials.token),
            SnapshotStore(applicationContext.filesDir),
            OutboundQueue(applicationContext.filesDir),
        )
        coordinator.drainQueue()
        TodayWidget().updateAll(applicationContext)
        return Result.success()
    }
}
