package sh.openagi.mobile.widget

import android.content.Context
import android.util.Log
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.DrainWorker

class CompleteTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val taskId = parameters[taskIdKey] ?: return
        // Hide it now, send it when we can. A tap that visibly does nothing for
        // fifteen minutes is worse than no widget at all — but a widget host
        // that crashes gets deprioritized by the OS, which silently kills the
        // feature entirely. applyOptimisticCompletion/enqueue both reach
        // File.writeText, which throws IOException on a full or read-only
        // filesystem, so every write here is best-effort, same as iOS's
        // `try?` on the equivalent path.
        try {
            SnapshotStore(context.filesDir).applyOptimisticCompletion(taskId)
            OutboundQueue(context.filesDir).enqueue(PendingOp.completeTask(taskId))
        } catch (error: Exception) {
            Log.w("CompleteTaskAction", "optimistic completion write failed: ${error.javaClass.simpleName}")
        }
        try {
            TodayWidget().updateAll(context)
        } catch (error: Exception) {
            Log.w("CompleteTaskAction", "widget repaint failed: ${error.javaClass.simpleName}")
        }
        try {
            WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<DrainWorker>().build())
        } catch (error: Exception) {
            Log.w("CompleteTaskAction", "drain enqueue failed: ${error.javaClass.simpleName}")
        }
    }

    companion object {
        val taskIdKey = ActionParameters.Key<String>("taskId")
    }
}
