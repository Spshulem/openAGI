package sh.openagi.mobile.sync

import sh.openagi.mobile.protocol.PendingAction
import sh.openagi.mobile.transport.DaemonException

// What one check should do about approval notifications: cards to ping about
// now, and ids whose notification should go away.
data class ApprovalPlan(val post: List<PendingAction>, val cancel: List<String>)

enum class ApprovalOutcome { Approved, Denied, NotPending, Failed, Retry }

private const val MAX_APPROVAL_ATTEMPTS = 3

// The decisions behind an approval notification (a pending action waiting on
// the owner, with Approve and Deny), free of Android types so they are pinned
// on the JVM. Mirrors SupervisorAlerts, and the daemon's iOS push
// (src/mobile-push.js approvalNeedsOwner / buildApproval).
//
// Summaries come from the agent. Display text only: never parsed, never
// placed in an intent as anything but notification text, never logged.
object ApprovalAlerts {
    // Ids land above the reserved range like question ids do; the
    // "approval/" prefix keeps an action id from sharing a notification with
    // a question id that happens to be the same string.
    private const val ID_PREFIX = "approval/"
    private const val TITLE = "Approve?"
    private const val TEXT_MAX = 220
    private const val FALLBACK_TEXT = "An action is waiting on your approval."

    // A queued approval or a chat card's code. An owner-mode record already
    // ran on the owner's own word; anything not pending is decided.
    fun needsOwner(action: PendingAction): Boolean =
        action.id.isNotBlank() && action.status == "pending" && action.mode != "owner"

    // Once per card id: a card the agent raises again with the same arguments
    // is the same card (the daemon reuses it), so it never pings twice. The
    // daemon lists newest first; the oldest backlog posts first.
    fun plan(pending: List<PendingAction>, notified: Set<String>): ApprovalPlan {
        val waiting = pending.filter(::needsOwner)
        val waitingIds = waiting.mapTo(HashSet()) { it.id }
        val post = waiting
            .filter { it.id !in notified }
            .distinctBy { it.id }
            .reversed()
            .take(SupervisorAlerts.MAX_POSTS_PER_CHECK)
        val cancel = notified.filter { it !in waitingIds }
        return ApprovalPlan(post, cancel)
    }

    fun notificationId(actionId: String): Int = SupervisorAlerts.notificationId(ID_PREFIX + actionId)

    fun title(action: PendingAction): String {
        val code = action.confirmCode?.trim().orEmpty()
        return if (code.isEmpty()) TITLE else "$TITLE (code $code)"
    }

    fun text(action: PendingAction): String =
        SupervisorAlerts.cap(action.summary.trim().ifEmpty { FALLBACK_TEXT }, TEXT_MAX)

    // The approval worker's policy. 404/409 on the decision means another
    // surface decided it first; a refused credential will not start working;
    // the rest gets three attempts. A retried approve is safe: the worker
    // checks the card is still pending first, and the daemon claims a card
    // once.
    fun outcome(error: Throwable?, attempt: Int, approve: Boolean, ok: Boolean = true): ApprovalOutcome = when (error) {
        null -> when {
            !ok -> ApprovalOutcome.Failed
            approve -> ApprovalOutcome.Approved
            else -> ApprovalOutcome.Denied
        }
        is DaemonException.NotFound, is DaemonException.Conflict -> ApprovalOutcome.NotPending
        is DaemonException.Unauthorized -> ApprovalOutcome.Failed
        else -> if (attempt + 1 < MAX_APPROVAL_ATTEMPTS) ApprovalOutcome.Retry else ApprovalOutcome.Failed
    }
}
