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
    fun failuresKeepTheCompletionQueued() {
        val queue = OutboundQueue(folder.root)
        val op = PendingOp.completeTask("task_4")
        queue.enqueue(op)
        repeat(OutboundQueue.MAX_ATTEMPTS) { queue.recordAttempt(op.id) }
        assertEquals(1, queue.all().size)
        assertEquals(OutboundQueue.MAX_ATTEMPTS, queue.all().single().attempts)
    }

    // After five failures the op remains durable, including across a fresh
    // queue instance, so reconnection can still deliver the completion.
    @Test
    fun exhaustionDoesNotHideAnUndeliveredTaskForever() {
        val queue = OutboundQueue(folder.root)
        val op = PendingOp.completeTask("task_5")
        queue.enqueue(op)
        repeat(4) { queue.recordAttempt(op.id) }
        assertEquals("must survive 4 failed attempts", 1, queue.all().size)
        queue.recordAttempt(op.id)
        assertEquals(1, OutboundQueue(folder.root).all().size)
        assertEquals(5, queue.all().single().attempts)
        queue.recordAttempt(op.id)
        assertEquals(5, queue.all().single().attempts)
    }
}
