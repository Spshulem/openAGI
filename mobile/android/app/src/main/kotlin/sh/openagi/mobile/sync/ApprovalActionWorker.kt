package sh.openagi.mobile.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.NotifiedQuestionsStore
import sh.openagi.mobile.transport.DaemonClient
import java.util.concurrent.TimeUnit

// Approves or denies one pending action tapped on its notification, through
// the same authenticated calls as the Inbox (POST /pending-actions/:id/approve
// or /deny with this phone's credential). The card is looked up again first:
// one that stopped waiting since the notification posted (decided on the Mac,
// in the Inbox, by a spoken "yes NN", or expired) is never sent. The result
// replaces the notification.
class ApprovalActionWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val actionId = inputData.getString(KEY_ACTION_ID)?.takeIf { it.isNotBlank() } ?: return Result.success()
        val approve = inputData.getBoolean(KEY_APPROVE, false)
        val app = applicationContext
        val store = NotifiedQuestionsStore(app.filesDir, NotifiedQuestionsStore.APPROVALS_FILE_NAME)
        val credentials = Credentials.load(app)
        if (credentials == null) {
            SupervisorNotifier.cancelApproval(app, actionId)
            return Result.success()
        }
        val client = DaemonClient(credentials.server, credentials.nodeId, credentials.token)
        var stillPending = true
        var ok = true
        var failure: String? = null
        val error = try {
            stillPending = client.pendingActions("pending").any { it.id == actionId }
            if (stillPending) {
                if (approve) {
                    val result = client.approveAction(actionId)
                    ok = result.ok
                    failure = result.error
                } else {
                    client.denyAction(actionId)
                }
            }
            null
        } catch (cancellation: CancellationException) {
            // Run again by WorkManager; the pending check keeps a repeat safe.
            throw cancellation
        } catch (failed: Exception) {
            failed
        }
        val outcome = if (!stillPending && error == null) {
            ApprovalOutcome.NotPending
        } else {
            ApprovalAlerts.outcome(error, runAttemptCount, approve, ok)
        }
        return when (outcome) {
            ApprovalOutcome.Retry -> Result.retry()
            ApprovalOutcome.Failed -> {
                val title = if (error == null) "Approved, but it failed" else "Not done"
                val why = failure?.trim()?.takeIf { it.isNotEmpty() } ?: "Open Inbox to see it."
                SupervisorNotifier.showApprovalResult(app, actionId, title, why, silent = false)
                Result.success()
            }
            else -> {
                // Forgotten under the alert lock, so the next check does not
                // take the result down as a decided card's notification.
                withAlertLock { store.remove(actionId) }
                val (title, text) = when (outcome) {
                    ApprovalOutcome.Approved -> "Approved" to null
                    ApprovalOutcome.Denied -> "Denied" to null
                    else -> "Already decided" to "This approval is no longer waiting."
                }
                SupervisorNotifier.showApprovalResult(app, actionId, title, text, silent = outcome != ApprovalOutcome.NotPending)
                Result.success()
            }
        }
    }

    // See SupervisorAnswerWorker.getForegroundInfo: required by contract,
    // never called on this app's minSdk.
    override suspend fun getForegroundInfo(): ForegroundInfo =
        ForegroundInfo(SupervisorAnswerWorker.FOREGROUND_ID, SupervisorNotifier.answerWorkNotification(applicationContext))

    companion object {
        private const val TAG = "approval-action"
        private const val KEY_ACTION_ID = "actionId"
        private const val KEY_APPROVE = "approve"

        // KEEP: a second tap while one decision is pending is not a second
        // decision.
        fun enqueue(context: Context, actionId: String, approve: Boolean) {
            val request = OneTimeWorkRequestBuilder<ApprovalActionWorker>()
                .setInputData(workDataOf(KEY_ACTION_ID to actionId, KEY_APPROVE to approve))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .addTag(TAG)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork("approval-action-$actionId", ExistingWorkPolicy.KEEP, request)
        }

        // Forgetting a pairing: a decision still queued must not reach
        // whichever daemon this phone pairs with next.
        fun cancelAll(context: Context) {
            WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
        }
    }
}
