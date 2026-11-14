package sh.openagi.mobile.ui

import sh.openagi.mobile.protocol.FleetConversation
import sh.openagi.mobile.protocol.FleetConversationMessage
import sh.openagi.mobile.protocol.FleetDelivery
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.transport.DaemonException

// Free-text replies from the thread sheet: where a typed reply goes, what
// its result says, and when the draft may be cleared. Pure, so it is tested
// without a device.
object ReplyFormat {
    // The hub's own limit (src/fleet/routes.js SEND_MAX, and the question
    // reply's 1..2000).
    const val MAX_LENGTH = 2000

    // How many messages the sheet shows before "Show earlier".
    const val RECENT_MESSAGES = 12

    sealed class Target {
        // POST /fleet/api/questions/:id { reply }: closes the question.
        data class Question(val id: String, val risky: Boolean) : Target()

        // POST /fleet/api/send { threadKey, message }.
        data class Thread(val key: String) : Target()

        // No free text from the phone; why, in words.
        data class None(val reason: String) : Target()
    }

    // The question the reply answers: the one the sheet was opened from,
    // else one that takes a reply, else a risky one (which must not be
    // bypassed by a plain send). A question that takes a reply gets it.
    // While a risky question that does not is open, nothing is typed from
    // here: a plain send could reach the chat by a relay rather than typed
    // as the owner. Anything else goes to the thread as the owner's own
    // message.
    fun target(questions: List<FleetQuestion>, focusId: String?, threadKey: String?): Target {
        val open = questions.filter { it.id.isNotBlank() }
        val question = open.firstOrNull { it.id == focusId }
            ?: open.firstOrNull { it.canReply }
            ?: open.firstOrNull { it.risky }
        if (question != null && question.canReply) return Target.Question(question.id, question.risky)
        if (open.any { it.risky && !it.canReply }) {
            return Target.None("This one can't be undone easily. Answer it with a button above, or in the chat itself.")
        }
        val key = threadKey?.trim()?.takeIf { it.isNotEmpty() }
            ?: return Target.None("This question has no chat to reply to.")
        return Target.Thread(key)
    }

    // Trimmed and within the hub's limit; null when nothing to send.
    fun cleaned(draft: String): String? = draft.trim().takeIf { it.isNotEmpty() && it.length <= MAX_LENGTH }

    // Only a reply the hub took (sent, or queued for when the Mac can type)
    // clears the draft; blocked or failed keeps it to try again.
    fun clearsDraft(delivery: FleetDelivery?): Boolean = delivery?.status == "sent" || delivery?.status == "queued"

    fun deliveryNote(delivery: FleetDelivery?): SupervisorFormat.Note {
        val detail = delivery?.detail?.trim()?.takeIf { it.isNotEmpty() }
        return when (delivery?.status) {
            "sent" -> SupervisorFormat.Note("Sent to the agent.", isAlert = false)
            "queued" -> SupervisorFormat.Note("Queued. It is typed in when your Mac can.", isAlert = false)
            "blocked" -> SupervisorFormat.Note("Not sent" + (detail?.let { ": " + it.trimEnd('.') } ?: "") + ". Your reply is kept.", isAlert = true)
            "failed" -> SupervisorFormat.Note("Send failed" + (detail?.let { ": " + it.trimEnd('.') } ?: "") + ". Your reply is kept.", isAlert = true)
            else -> SupervisorFormat.Note("Sent.", isAlert = false)
        }
    }

    // 401/403: a hub that does not yet open replies to phones (or, for
    // /send, has no such route).
    const val UPDATE_HUB = "Update the hub to reply from the phone"

    fun failureText(error: DaemonException): String? = when (error) {
        is DaemonException.Unauthorized -> UPDATE_HUB
        else -> null
    }

    // The newest messages, oldest first, unless the owner asked for all.
    fun visible(conversation: FleetConversation, showAll: Boolean): List<FleetConversationMessage> =
        if (showAll) conversation.messages else conversation.messages.takeLast(RECENT_MESSAGES)

    // The agent's words are its own, checked by no one.
    fun speaker(message: FleetConversationMessage): String = if (message.fromOwner) "You" else "Agent (unverified)"
}
