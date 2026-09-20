package sh.openagi.mobile.transport

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class EventStreamTest {
    @Test
    fun aFailingFirstAttemptStillReconnectsAndDeliversFrames() = runTest {
        var attempts = 0
        val stream = EventStream {
            attempts++
            if (attempts == 1) flow<SseFrame> { throw DaemonException.Transport(IOException("dropped")) }
            else flowOf(SseFrame("hello", "{}"))
        }
        val frames = stream.connect().take(1).toList()
        assertEquals(listOf(SseFrame("hello", "{}")), frames)
        assertEquals(2, attempts)
    }

    @Test
    fun backsOffBetweenAFailedAttemptAndTheNextRedial() = runTest {
        var attempts = 0
        val stream = EventStream {
            attempts++
            if (attempts == 1) flow<SseFrame> { throw DaemonException.Transport(IOException("dropped")) }
            else flowOf(SseFrame("hello", "{}"))
        }
        stream.connect().take(1).toList()
        // ReconnectBackoff's floor is 1000ms; virtual time must have advanced
        // by at least that much between the failed attempt and the retry that
        // followed it, rather than hot-looping reconnects.
        assertTrue(testScheduler.currentTime >= 1_000L)
    }

    @Test
    fun resetsTheBackoffCounterAfterAFrameArrivesEvenAcrossMultipleDrops() = runTest {
        var attempts = 0
        val stream = EventStream {
            attempts++
            when (attempts) {
                1 -> flowOf(SseFrame("hello", "{}")) // succeeds once, resets the counter
                2 -> flow<SseFrame> { throw DaemonException.Transport(IOException("dropped again")) }
                else -> flowOf(SseFrame("task-updated", "{}"))
            }
        }
        val received = stream.connect().take(2).toList()
        assertEquals(listOf("hello", "task-updated"), received.map { it.event })
        assertEquals(3, attempts)
    }

    @Test
    fun connectOnceIsCalledAgainOnEveryRedial() = runTest {
        var calls = 0
        val stream: EventStream = EventStream {
            calls++
            flow<SseFrame> { throw DaemonException.Transport(IOException("always drops")) }
        }
        // Never emits, so take(1) would never complete on its own — bound the
        // observation window instead of asserting on an emitted value.
        val job = launch { stream.connect().collect { } }
        advanceTimeBy(10_000)
        job.cancel()
        assertTrue("expected multiple reconnect attempts, got $calls", calls > 1)
    }
}
