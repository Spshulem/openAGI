package sh.openagi.mobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

// An answer button, or the Reply field, on a supervisor question
// notification. Not exported: only this app's own PendingIntents
// (SupervisorNotifier) can reach it.
// The network call can take up to ~190s while the daemon relays the answer to
// a live agent — far past a receiver's ten seconds — so this only swaps the
// buttons for a "sending" notice and hands the send to WorkManager, which
// also carries it across a dropped connection or a killed process.
class SupervisorAnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val questionId = intent.getStringExtra(SupervisorNotifier.EXTRA_QUESTION_ID)?.takeIf { it.isNotBlank() } ?: return
        when (intent.action) {
            ACTION_ANSWER -> {
                val answer = intent.getStringExtra(EXTRA_ANSWER)?.takeIf { it.isNotBlank() } ?: return
                SupervisorNotifier.showSending(context, questionId, answer)
                SupervisorAnswerWorker.enqueue(context, questionId, answer)
            }
            ACTION_REPLY -> {
                // What the owner typed; an empty send leaves the question as is.
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(SupervisorNotifier.KEY_REPLY_TEXT)
                    ?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return
                SupervisorNotifier.showSending(context, questionId, text)
                SupervisorAnswerWorker.enqueue(context, questionId, text, reply = true)
            }
        }
    }

    companion object {
        const val ACTION_ANSWER = "sh.openagi.mobile.action.ANSWER_QUESTION"
        const val ACTION_REPLY = "sh.openagi.mobile.action.REPLY_QUESTION"
        const val EXTRA_ANSWER = "sh.openagi.mobile.extra.ANSWER"
    }
}
