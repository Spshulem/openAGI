package sh.openagi.mobile.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class ReconnectBackoffTest {
    @Test
    fun startsAtOneSecond() {
        assertEquals(1_000L, ReconnectBackoff.delayMillis(0))
    }

    @Test
    fun doublesEachAttempt() {
        assertEquals(1_000L, ReconnectBackoff.delayMillis(0))
        assertEquals(2_000L, ReconnectBackoff.delayMillis(1))
        assertEquals(4_000L, ReconnectBackoff.delayMillis(2))
        assertEquals(8_000L, ReconnectBackoff.delayMillis(3))
        assertEquals(16_000L, ReconnectBackoff.delayMillis(4))
    }

    @Test
    fun capsAtThirtySeconds() {
        assertEquals(30_000L, ReconnectBackoff.delayMillis(5))
        assertEquals(30_000L, ReconnectBackoff.delayMillis(100))
    }

    @Test
    fun negativeAttemptsAreTreatedAsTheFirst() {
        assertEquals(1_000L, ReconnectBackoff.delayMillis(-1))
    }
}
