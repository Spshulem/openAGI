package sh.openagi.mobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Approve or Deny on an approval notification. Not exported: only this app's
// own immutable PendingIntents (SupervisorNotifier) can reach it, and both
// actions require the phone to be unlocked before the system delivers them.
// The decision itself runs in ApprovalActionWorker, which checks the card is
// still pending and then makes the same call the Inbox makes.
class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val approve = when (intent.action) {
            ACTION_APPROVE -> true
            ACTION_DENY -> false
            else -> return
        }
        val actionId = intent.getStringExtra(SupervisorNotifier.EXTRA_ACTION_ID)?.takeIf { it.isNotBlank() } ?: return
        SupervisorNotifier.showApprovalSending(context, actionId, approve)
        ApprovalActionWorker.enqueue(context, actionId, approve)
    }

    companion object {
        const val ACTION_APPROVE = "sh.openagi.mobile.action.APPROVE_ACTION"
        const val ACTION_DENY = "sh.openagi.mobile.action.DENY_ACTION"
    }
}
