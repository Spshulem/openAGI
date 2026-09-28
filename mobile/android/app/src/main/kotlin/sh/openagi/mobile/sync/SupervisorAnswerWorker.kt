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
import sh.openagi.mobile.transport.DaemonException
import java.util.concurrent.TimeUnit

enum class AnswerOutcome { Done, Retry, Failed }

private const val MAX_ANSWER_ATTEMPTS = 3

// The whole retry policy, pure so it is pinned on the JVM. `attempt` is
// WorkManager's runAttemptCount: 0 on the first run.
//
// Done covers "already closed" as well as success: 404 and 409 both mean the
// question is no longer open (PROTOCOL.md, "Fleet supervisor routes") —
// answered on the Mac or another phone, or resolved by the supervisor — so
// there is nothing left to send. A refused credential will not start working
// on a retry. Everything else (offline, a timeout mid-relay, a daemon
// restarting) gets three attempts in all.
fun answerOutcome(error: Throwable?, attempt: Int): AnswerOutcome = when (error) {
    null, is DaemonException.NotFound, is DaemonException.Conflict -> AnswerOutcome.Done
    is DaemonException.Unauthorized -> AnswerOutcome.Failed
    else -> if (attempt + 1 < MAX_ANSWER_ATTEMPTS) AnswerOutcome.Retry else AnswerOutcome.Failed
}

// Sends one answer (or dismissal) tapped on a supervisor notification.
class SupervisorAnswerWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val questionId = inputData.getString(KEY_QUESTION_ID)?.takeIf { it.isNotBlank() } ?: return Result.success()
        val answer = inputData.getString(KEY_ANSWER)?.takeIf { it.isNotBlank() } ?: return Result.success()
        val store = NotifiedQuestionsStore(applicationContext.filesDir)
        // Unpaired since the tap: there is no daemon to send to, and the
        // "sending" notice would otherwise spin forever.
        val credentials = Credentials.load(applicationContext)
        if (credentials == null) {
            SupervisorNotifier.cancel(applicationContext, questionId)
            return Result.success()
        }
        val client = DaemonClient(credentials.server, credentials.nodeId, credentials.token)
        val error = try {
            if (answer == DISMISS) client.fleetDismiss(questionId) else client.fleetAnswer(questionId, answer)
            null
        } catch (cancellation: CancellationException) {
            // Stopped by the system (quota, constraints): WorkManager runs it
            // again, and a repeat of an answer that did land is a 404 → Done.
            throw cancellation
        } catch (failure: Exception) {
            failure
        }
        return when (answerOutcome(error, runAttemptCount)) {
            AnswerOutcome.Done -> {
                SupervisorNotifier.cancel(applicationContext, questionId)
                // Forgotten rather than kept: the daemon reopens a question
                // under the same id when a background relay never reached the
                // agent, and that reopen must ping again.
                store.remove(questionId)
                Result.success()
            }
            AnswerOutcome.Retry -> Result.retry()
            AnswerOutcome.Failed -> {
                // A check that saw the question close meanwhile has already
                // dropped it from the store; a failure notice for a question
                // nobody is waiting on would only be noise.
                if (questionId in store.load()) {
                    SupervisorNotifier.showFailed(applicationContext, questionId, "Couldn't send your answer")
                }
                Result.failure()
            }
        }
    }

    // Expedited work must provide this. WorkManager only calls it below
    // Android 12 (from 12 on, expedited work is a JobScheduler expedited job
    // with no notification), so on this app's minSdk it never runs — but a
    // missing override throws instead of falling back.
    override suspend fun getForegroundInfo(): ForegroundInfo =
        ForegroundInfo(FOREGROUND_ID, SupervisorNotifier.answerWorkNotification(applicationContext))

    companion object {
        private const val TAG = "supervisor-answer"
        private const val KEY_QUESTION_ID = "questionId"
        private const val KEY_ANSWER = "answer"
        private const val DISMISS = "dismiss"

        // Below SupervisorAlerts.FIRST_QUESTION_ID, clear of the live-alerts
        // service's ongoing notification (1001).
        const val FOREGROUND_ID = 1002

        // Expedited so a tap sends now rather than whenever the job scheduler
        // next batches work; out of quota, it still runs as ordinary work.
        // KEEP: a second tap on the same question while one send is pending
        // is the same intent, not a second answer. A finished (failed) send
        // does not block a fresh one.
        fun enqueue(context: Context, questionId: String, answer: String) {
            val request = OneTimeWorkRequestBuilder<SupervisorAnswerWorker>()
                .setInputData(workDataOf(KEY_QUESTION_ID to questionId, KEY_ANSWER to answer))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .addTag(TAG)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork("supervisor-answer-$questionId", ExistingWorkPolicy.KEEP, request)
        }

        // Forgetting a pairing: an answer still queued must not be sent to
        // whichever daemon this phone pairs with next.
        fun cancelAll(context: Context) {
            WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
        }
    }
}
