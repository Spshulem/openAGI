package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.FleetConversation
import sh.openagi.mobile.protocol.FleetConversationMessage
import sh.openagi.mobile.protocol.FleetDelivery
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.transport.DaemonException

class ReplyFormatTest {
    private fun q(id: String, canReply: Boolean = false, risky: Boolean = false) =
        FleetQuestion(id = id, threadKey = "codex:abc", canReply = canReply, risky = risky)

    @Test
    fun aQuestionThatTakesARepliesGetsIt() {
        assertEquals(ReplyFormat.Target.Question("q1", risky = false), ReplyFormat.target(listOf(q("q1", canReply = true)), "q1", "codex:abc"))
    }

    @Test
    fun withoutCanReplyTheReplyGoesToTheThread() {
        assertEquals(ReplyFormat.Target.Thread("codex:abc"), ReplyFormat.target(listOf(q("q1")), "q1", "codex:abc"))
        assertEquals(ReplyFormat.Target.Thread("codex:abc"), ReplyFormat.target(emptyList(), null, "codex:abc"))
    }

    @Test
    fun theFocusedQuestionWinsThenAnyThatTakesAReply() {
        val questions = listOf(q("q1"), q("q2", canReply = true), q("q3", canReply = true))
        assertEquals(ReplyFormat.Target.Question("q3", risky = false), ReplyFormat.target(questions, "q3", "codex:abc"))
        assertEquals(ReplyFormat.Target.Question("q2", risky = false), ReplyFormat.target(questions, null, "codex:abc"))
        // Focus on one without reply: its thread, not another question.
        assertEquals(ReplyFormat.Target.Thread("codex:abc"), ReplyFormat.target(questions, "q1", "codex:abc"))
    }

    @Test
    fun aRiskyQuestionIsRepliedOnlyThroughItsOwnRoute() {
        assertEquals(ReplyFormat.Target.Question("r", risky = true), ReplyFormat.target(listOf(q("r", canReply = true, risky = true)), "r", "codex:abc"))
        // An older hub, or an agent card: never a plain send while it is open.
        assertTrue(ReplyFormat.target(listOf(q("r", risky = true)), "r", "codex:abc") is ReplyFormat.Target.None)
        assertTrue(ReplyFormat.target(listOf(q("plain"), q("r", risky = true)), "plain", "codex:abc") is ReplyFormat.Target.None)
    }

    @Test
    fun noThreadMeansNoReply() {
        assertTrue(ReplyFormat.target(emptyList(), null, " ") is ReplyFormat.Target.None)
        assertTrue(ReplyFormat.target(emptyList(), null, null) is ReplyFormat.Target.None)
    }

    @Test
    fun theDraftIsTrimmedAndBounded() {
        assertEquals("hi", ReplyFormat.cleaned("  hi \n"))
        assertNull(ReplyFormat.cleaned("   "))
        assertEquals(2000, ReplyFormat.cleaned("a".repeat(2000))!!.length)
        assertNull(ReplyFormat.cleaned("a".repeat(2001)))
    }

    @Test
    fun onlyATakenReplyClearsTheDraft() {
        assertTrue(ReplyFormat.clearsDraft(FleetDelivery(status = "sent")))
        assertTrue(ReplyFormat.clearsDraft(FleetDelivery(status = "queued")))
        assertFalse(ReplyFormat.clearsDraft(FleetDelivery(status = "blocked", detail = "approve it in the chat")))
        assertFalse(ReplyFormat.clearsDraft(FleetDelivery(status = "failed")))
        assertFalse(ReplyFormat.clearsDraft(null))
    }

    @Test
    fun notesSayWhatHappened() {
        assertFalse(ReplyFormat.deliveryNote(FleetDelivery(status = "queued")).isAlert)
        val blocked = ReplyFormat.deliveryNote(FleetDelivery(status = "blocked", detail = "approve it in the chat"))
        assertTrue(blocked.isAlert)
        assertEquals("Not sent: approve it in the chat. Your reply is kept.", blocked.text)
    }

    @Test
    fun anOlderHubAsksForAnUpdate() {
        assertEquals("Update the hub to reply from the phone", ReplyFormat.failureText(DaemonException.Unauthorized()))
        assertNull(ReplyFormat.failureText(DaemonException.Conflict()))
    }

    @Test
    fun theNewestMessagesShowFirst() {
        val messages = (1..20).map { FleetConversationMessage(id = "m$it", role = "assistant", text = "t$it") }
        val conversation = FleetConversation(messages)
        assertEquals((9..20).map { "m$it" }, ReplyFormat.visible(conversation, showAll = false).map { it.id })
        assertEquals(20, ReplyFormat.visible(conversation, showAll = true).size)
        assertEquals("You", ReplyFormat.speaker(FleetConversationMessage(role = "user", text = "x")))
    }
}
