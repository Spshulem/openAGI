package sh.openagi.mobile.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OutboundQueueTest {
    @get:Rule val folder = TemporaryFolder()

    @Test
    fun enqueueAndDrain() {
        val queue = OutboundQueue(folder.root)
        assertTrue(queue.all().isEmpty())
        val op = PendingOp.completeTask("task_1")
        queue.enqueue(op)
        assertEquals(listOf(PendingOp.Kind.CompleteTask("task_1")), queue.all().map { it.kind })
        queue.remove(op.id)
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun opsSurviveAFreshProcess() {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_2"))
        assertEquals(1, OutboundQueue(folder.root).all().size)
    }

    @Test
    fun duplicateCompletionsCollapse() {
        // Two taps on the same widget row must not produce two queued POSTs.
        val queue = OutboundQueue(folder.root)
        queue.enqueue(PendingOp.completeTask("task_3"))
        queue.enqueue(PendingOp.completeTask("task_3"))
        assertEquals(1, queue.all().size)
    }

    @Test
    fun attemptsAreCountedAndCapped() {
        val queue = OutboundQueue(folder.root)
        val op = PendingOp.completeTask("task_4")
        queue.enqueue(op)
        repeat(OutboundQueue.MAX_ATTEMPTS) { queue.recordAttempt(op.id) }
        assertTrue("an op that keeps failing must eventually be dropped", queue.all().isEmpty())
    }

    // The test above loops to OutboundQueue.MAX_ATTEMPTS itself, so it would
    // pass for any cap value the implementation happens to check against —
    // it is self-referential and proves nothing about the cap actually being
    // 5. Pin the real number here instead.
    @Test
    fun theCapIsExactlyFiveAttempts() {
        val queue = OutboundQueue(folder.root)
        val op = PendingOp.completeTask("task_5")
        queue.enqueue(op)
        repeat(4) { queue.recordAttempt(op.id) }
        assertEquals("must survive 4 failed attempts", 1, queue.all().size)
        queue.recordAttempt(op.id)
        assertTrue("must be dropped after the 5th failed attempt", queue.all().isEmpty())
    }
}
