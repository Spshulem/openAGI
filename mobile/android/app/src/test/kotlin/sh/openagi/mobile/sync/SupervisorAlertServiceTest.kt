package sh.openagi.mobile.sync

import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SupervisorAlertServiceTest {
    @Test
    fun aBurstOfFramesRunsOneCheckWhenTheWindowCloses() = runTest {
        var checks = 0
        val coalescer = CheckCoalescer(3_000) { checks++ }
        val job = launch { coalescer.run() }
        runCurrent()

        coalescer.request()
        advanceTimeBy(1_000)
        coalescer.request()
        advanceTimeBy(1_000)
        coalescer.request()
        advanceTimeBy(900)
        runCurrent()
        assertEquals("nothing runs inside the window", 0, checks)

        advanceTimeBy(200)
        runCurrent()
        assertEquals(1, checks)

        // The requests inside the window were folded into that one check.
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, checks)
        job.cancel()
    }

    @Test
    fun aFrameThatArrivesDuringACheckRunsOneMoreCheck() = runTest {
        var checks = 0
        lateinit var coalescer: CheckCoalescer
        coalescer = CheckCoalescer(3_000) {
            checks++
            // A question lands while the first fetch is still in flight.
            if (checks == 1) coalescer.request()
            delay(500)
        }
        val job = launch { coalescer.run() }
        runCurrent()

        coalescer.request()
        advanceTimeBy(3_600)
        runCurrent()
        assertEquals(1, checks)

        advanceTimeBy(3_100)
        runCurrent()
        assertEquals(2, checks)

        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(2, checks)
        job.cancel()
    }

    @Test
    fun reactsToTheFramesThatCanChangeOpenQuestions() {
        listOf("hello", "fleet", "outreach", "outreach-resolved").forEach {
            assertTrue(it, it in ALERT_TRIGGERING_EVENTS)
        }
        // Chat traffic and task churn never move the supervisor's questions.
        listOf("message", "conversation.updated", "task-updated", "pending-action").forEach {
            assertTrue(it, it !in ALERT_TRIGGERING_EVENTS)
        }
    }
}
