package sh.openagi.mobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// An answer button on a supervisor question notification. Not exported: only
// this app's own immutable PendingIntents (SupervisorNotifier) can reach it.
// The network call can take up to ~190s while the daemon relays the answer to
// a live agent — far past a receiver's ten seconds — so this only swaps the
// buttons for a "sending" notice and hands the send to WorkManager, which
// also carries it across a dropped connection or a killed process.
class SupervisorAnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ANSWER) return
        val questionId = intent.getStringExtra(SupervisorNotifier.EXTRA_QUESTION_ID)?.takeIf { it.isNotBlank() } ?: return
        val answer = intent.getStringExtra(EXTRA_ANSWER)?.takeIf { it.isNotBlank() } ?: return
        SupervisorNotifier.showSending(context, questionId, answer)
        SupervisorAnswerWorker.enqueue(context, questionId, answer)
    }

    companion object {
        const val ACTION_ANSWER = "sh.openagi.mobile.action.ANSWER_QUESTION"
        const val EXTRA_ANSWER = "sh.openagi.mobile.extra.ANSWER"
    }
}
