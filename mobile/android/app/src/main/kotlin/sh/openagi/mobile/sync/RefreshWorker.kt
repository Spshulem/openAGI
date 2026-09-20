package sh.openagi.mobile.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import java.util.concurrent.TimeUnit

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val credentials = Credentials.load(applicationContext) ?: return Result.success()
        val coordinator = RefreshCoordinator(
            DaemonClient(credentials.server, credentials.nodeId, credentials.token),
            SnapshotStore(applicationContext.filesDir),
            OutboundQueue(applicationContext.filesDir),
        )
        coordinator.refresh()
        // Task 15 adds the TodayWidget().updateAll(applicationContext) call here,
        // once the widget and the Glance dependency exist. There is nothing to
        // repaint until then, and a forward reference would not compile.
        // An offline phone is the normal case off the tailnet, not a failure
        // worth exponential backoff on a 15-minute schedule, so every outcome
        // is success.
        return Result.success()
    }

    companion object {
        private const val NAME = "openagi-refresh"

        // 15 minutes is WorkManager's floor. Without a push channel this is the
        // honest ceiling on widget freshness, and the widget says so on screen.
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
