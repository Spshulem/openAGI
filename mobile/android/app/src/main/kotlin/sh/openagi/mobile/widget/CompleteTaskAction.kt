package sh.openagi.mobile.widget

import android.content.Context
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
        // fifteen minutes is worse than no widget at all.
        SnapshotStore(context.filesDir).applyOptimisticCompletion(taskId)
        OutboundQueue(context.filesDir).enqueue(PendingOp.completeTask(taskId))
        TodayWidget().updateAll(context)
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<DrainWorker>().build())
    }

    companion object {
        val taskIdKey = ActionParameters.Key<String>("taskId")
    }
}
