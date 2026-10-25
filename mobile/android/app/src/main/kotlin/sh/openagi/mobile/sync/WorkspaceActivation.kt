package sh.openagi.mobile.sync

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sh.openagi.mobile.embedded.EmbeddedAgent
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.NotifiedQuestionsStore
import sh.openagi.mobile.widget.TodayWidget

// Switching workspaces preserves each outbox and pairing, but cancels actions
// in the notification shade that belong to the workspace being left.
suspend fun activateWorkspace(context: Context, credentials: Credentials?) = withContext(Dispatchers.IO) {
    withAlertLock {
        val previous = Credentials.load(context)
        check(if (credentials == null) Credentials.clear(context) else Credentials.save(context, credentials)) {
            "Couldn't save the active workspace securely."
        }
        if (previous?.workspaceId != credentials?.workspaceId) {
            SupervisorAlertService.stop(context)
            SupervisorNotifier.cancelAll(context, NotifiedQuestionsStore(context.filesDir))
        }
        if (credentials == null) RefreshWorker.cancel(context)
        else RefreshWorker.schedule(context, credentials)
    }
    // Immediately replace old rows even before the first network refresh.
    runCatching { TodayWidget().updateAll(context) }
    if (credentials != null) WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<RefreshWorker>().build())
    Unit
}

// WorkManager can start a fresh process without MainActivity. Only the native
// host can restore the current loopback port and validate/enroll its node.
internal suspend fun backgroundCredentials(context: Context, expectedWorkspace: String? = null): Credentials? {
    val saved = Credentials.load(context) ?: return null
    if (expectedWorkspace != null && saved.workspaceId != expectedWorkspace) return null
    val current = if (saved.isEmbedded) EmbeddedAgent.start(context, activate = false) else saved
    return withAlertLock {
        if (Credentials.load(context) != saved) null
        else {
            check(Credentials.save(context, current)) { "Couldn't save the current workspace securely." }
            current
        }
    }
}
