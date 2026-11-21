package sh.openagi.mobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.PendingAction
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.transport.DaemonException
import java.io.IOException

class ApprovalAlertsTest {
    private fun action(id: String, status: String = "pending", mode: String? = "chat", summary: String = "Run $id", code: String? = null) =
        PendingAction(id = id, toolName = "send_email", summary = summary, status = status, mode = mode, confirmCode = code)

    // Newest first from the daemon; the oldest waiting card pings first.
    @Test
    fun postsWaitingCardsNotYetNotifiedOldestFirst() {
        val plan = ApprovalAlerts.plan(
            pending = listOf(action("act_c"), action("act_b", mode = "queue"), action("act_a")),
            notified = setOf("act_b"),
        )
        assertEquals(listOf("act_a", "act_c"), plan.post.map { it.id })
        assertTrue(plan.cancel.isEmpty())
    }

    // A card the agent raises again with the same arguments is the same card:
    // once notified it never pings again.
    @Test
    fun aReRaisedCardDoesNotPingTwice() {
        val plan = ApprovalAlerts.plan(listOf(action("act_a"), action("act_a")), setOf("act_a"))
        assertTrue(plan.post.isEmpty())
        assertEquals(listOf("act_a"), ApprovalAlerts.plan(listOf(action("act_a"), action("act_a")), emptySet()).post.map { it.id })
    }

    @Test
    fun onlyPendingCardsThatWaitOnTheOwnerPing() {
        val plan = ApprovalAlerts.plan(
            pending = listOf(
                action("act_owner", status = "executing", mode = "owner"),
                action("act_owner2", mode = "owner"),
                action("act_done", status = "approved"),
                action(""),
                action("act_legacy", mode = null),
            ),
            notified = emptySet(),
        )
        assertEquals(listOf("act_legacy"), plan.post.map { it.id })
    }

    // Decided anywhere (the Mac, the Inbox, a spoken "yes NN"): its
    // notification comes down.
    @Test
    fun cancelsNotifiedCardsNoLongerWaiting() {
        val plan = ApprovalAlerts.plan(listOf(action("act_b")), linkedSetOf("act_a", "act_b"))
        assertEquals(listOf("act_a"), plan.cancel)
    }

    @Test
    fun aBacklogPostsAtMostFivePerCheck() {
        val plan = ApprovalAlerts.plan((1..8).map { action("act_$it") }, emptySet())
        assertEquals(SupervisorAlerts.MAX_POSTS_PER_CHECK, plan.post.size)
    }

    @Test
    fun notificationIdsNeverCollideWithTheSameQuestionIdOrTheReservedRange() {
        assertNotEquals(SupervisorAlerts.notificationId("x1"), ApprovalAlerts.notificationId("x1"))
        assertEquals(ApprovalAlerts.notificationId("act_1"), ApprovalAlerts.notificationId("act_1"))
        assertTrue(ApprovalAlerts.notificationId("act_1") >= SupervisorAlerts.FIRST_QUESTION_ID)
    }

    @Test
    fun titleCarriesTheSpokenCodeAndTextIsCappedWithAFallback() {
        assertEquals("Approve? (code 42)", ApprovalAlerts.title(action("a", code = "42")))
        assertEquals("Approve?", ApprovalAlerts.title(action("a")))
        assertEquals(220, ApprovalAlerts.text(action("a", summary = "s".repeat(300))).length)
        assertTrue(ApprovalAlerts.text(action("a", summary = "  ")).isNotBlank())
    }

    @Test
    fun outcomePolicy() {
        assertEquals(ApprovalOutcome.Approved, ApprovalAlerts.outcome(null, attempt = 0, approve = true))
        assertEquals(ApprovalOutcome.Denied, ApprovalAlerts.outcome(null, attempt = 0, approve = false))
        assertEquals(ApprovalOutcome.Failed, ApprovalAlerts.outcome(null, attempt = 0, approve = true, ok = false))
        // Decided by another surface between the check and the call.
        assertEquals(ApprovalOutcome.NotPending, ApprovalAlerts.outcome(DaemonException.Conflict(), attempt = 0, approve = true))
        assertEquals(ApprovalOutcome.NotPending, ApprovalAlerts.outcome(DaemonException.NotFound(), attempt = 0, approve = false))
        assertEquals(ApprovalOutcome.Failed, ApprovalAlerts.outcome(DaemonException.Unauthorized(), attempt = 0, approve = true))
        assertEquals(ApprovalOutcome.Retry, ApprovalAlerts.outcome(DaemonException.Transport(IOException()), attempt = 1, approve = true))
        assertEquals(ApprovalOutcome.Failed, ApprovalAlerts.outcome(DaemonException.Transport(IOException()), attempt = 2, approve = true))
    }

    @Test
    fun decodesModeAndCodeAndToleratesTheirAbsence() {
        val json = """{"actions":[{"id":"act_1","toolName":"send_email","summary":"Email Alex","status":"pending","mode":"chat","confirmCode":"42"},
            {"id":"act_2","toolName":"x","status":"pending"}]}"""
        val actions = ProtocolJson.json.decodeFromString(sh.openagi.mobile.protocol.PendingActionsResponse.serializer(), json).actions
        assertEquals("chat", actions[0].mode)
        assertEquals("42", actions[0].confirmCode)
        assertEquals(null, actions[1].mode)
        assertEquals(listOf("act_1", "act_2"), ApprovalAlerts.plan(actions, emptySet()).post.map { it.id }.sorted())
    }
}
