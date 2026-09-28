package sh.openagi.mobile.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import sh.openagi.mobile.protocol.ConversationMessage
import sh.openagi.mobile.protocol.ConversationPage
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SseFrame
import java.time.Instant

// Shared-thread history paging, offline recovery, and the fallback for a
// daemon that predates shared threads.
class SharedThreadSyncTest {
    private val t = Instant.parse("2026-09-28T15:00:00Z")
    private fun msg(id: String) = ConversationMessage(id, if (id.removePrefix("m").toInt() % 2 == 0) "user" else "assistant", id, t, "other", "Glasses")
    private fun page(vararg ids: String, nextBefore: String? = null) = ConversationPage("agent", ids.map { msg(it) }, nextBefore)
    private fun state(support: SharedThreadSupport = SharedThreadSupport(), legacy: String? = null) =
        ChatConversationState(CoroutineScope(Dispatchers.Unconfined), nodeId = "me", thread = "agent", legacySessionKey = legacy, threadSupport = support)
            .also { it.refreshRetryDelaysMs = listOf(0L, 0L) }
    private fun shown(state: ChatConversationState) = state.messages.value.map { it.serverId }

    @Test
    fun aFailedHistoryLoadIsRetriedAndARefreshAfterReconnectLoadsIt() {
        val s = state()
        var calls = 0
        s.requestRefresh { _, _ -> calls++; throw DaemonException.Transport(java.io.IOException("offline")) }
        assertEquals("first try plus bounded retries", 3, calls)
        assertTrue(s.messages.value.isEmpty())
        // The /events stream reconnects (hello) and asks again.
        s.requestRefresh { _, before -> assertEquals(null, before); page("m2", "m3", nextBefore = "m2") }
        assertEquals(listOf("m2", "m3"), shown(s))
        assertFalse(s.olderExhausted.value)
    }

    @Test
    fun aMissingRouteIsNotRetried() {
        val s = state()
        var calls = 0
        s.requestRefresh { _, _ -> calls++; throw DaemonException.NotFound() }
        assertEquals(1, calls)
    }

    @Test
    fun earlierMessagesPageBackWithTheCursorAndSurviveTheNextRefresh() {
        val s = state()
        s.requestRefresh { _, _ -> page("m4", "m5", nextBefore = "m4") }
        val cursors = mutableListOf<String?>()
        s.loadOlder { _, before -> cursors += before; page("m2", "m3", nextBefore = "m2") }
        s.loadOlder { _, before -> cursors += before; page("m0", "m1") }
        assertEquals(listOf("m4", "m2"), cursors)
        assertEquals(listOf("m0", "m1", "m2", "m3", "m4", "m5"), shown(s))
        assertTrue(s.olderExhausted.value)
        s.loadOlder { _, _ -> fail("nothing older to load"); page() }
        // The newest page joins onto what is shown, so older lines stay.
        s.requestRefresh { _, _ -> page("m4", "m5", "m6", nextBefore = "m4") }
        assertEquals(listOf("m0", "m1", "m2", "m3", "m4", "m5", "m6"), shown(s))
        assertTrue(s.olderExhausted.value)
        assertEquals(7, s.messages.value.map { it.id }.toSet().size)
    }

    @Test
    fun aWholeThreadOnOnePageHasNothingOlder() {
        val s = state()
        s.requestRefresh { _, _ -> page("m0", "m1") }
        assertTrue(s.olderExhausted.value)
    }

    private data class Sent(val from: String?, val sessionId: String?, val thread: String?)
    private val reply = SseFrame("final", "{\"reply\":\"ok\"}")
    private fun rejectingThreads(sent: MutableList<Sent>): (String, String?, String?, String?) -> Flow<SseFrame> = { _, from, sessionId, thread ->
        sent += Sent(from, sessionId, thread)
        if (thread != null) flow { throw DaemonException.Server(400) } else flowOf(reply)
    }

    @Test
    fun anOlderDaemonRefusingThreadGetsTheSendAgainWithoutItOnce() = runBlocking {
        val support = SharedThreadSupport()
        val supervisor = state(support, legacy = "mobile-supervisor")
        val chat = state(support)
        val sent = mutableListOf<Sent>()
        assertEquals(listOf(reply), supervisor.messageStream("hi", null, null, rejectingThreads(sent)).toList())
        assertEquals(listOf(Sent(null, null, "agent"), Sent("mobile-supervisor", "mobile-supervisor", null)), sent)
        assertFalse(support.supported)
        // Remembered for the pairing: Chat goes straight to the old keying.
        sent.clear()
        assertEquals(listOf(reply), chat.messageStream("hi", null, null, rejectingThreads(sent)).toList())
        assertEquals(listOf(Sent(null, null, null)), sent)
        // No shared thread, so no history requests either.
        chat.requestRefresh { _, _ -> fail("legacy daemon has no thread history"); page() }
    }

    @Test
    fun otherFailuresAreNotResentWithoutTheThread() = runBlocking {
        val support = SharedThreadSupport()
        val s = state(support)
        val sent = mutableListOf<Sent>()
        val failing: (String, String?, String?, String?) -> Flow<SseFrame> = { _, from, sessionId, thread ->
            sent += Sent(from, sessionId, thread)
            flow { throw DaemonException.Server(500) }
        }
        try { s.messageStream("hi", null, null, failing).toList(); fail("expected 500") } catch (e: DaemonException.Server) { assertEquals(500, e.code) }
        assertEquals(1, sent.size)
        // A 400 after the reply started is not the thread field; no resend.
        sent.clear()
        val late: (String, String?, String?, String?) -> Flow<SseFrame> = { _, from, sessionId, thread ->
            sent += Sent(from, sessionId, thread)
            flow { emit(SseFrame("status", "{}")); throw DaemonException.Server(400) }
        }
        try { s.messageStream("hi", null, null, late).toList(); fail("expected 400") } catch (e: DaemonException.Server) { assertEquals(400, e.code) }
        assertEquals(1, sent.size)
        // A 400 the resend also gets (bad text on a new daemon) changes nothing.
        sent.clear()
        val always400: (String, String?, String?, String?) -> Flow<SseFrame> = { _, from, sessionId, thread ->
            sent += Sent(from, sessionId, thread)
            flow { throw DaemonException.Server(400) }
        }
        try { s.messageStream("hi", null, null, always400).toList(); fail("expected 400") } catch (e: DaemonException.Server) { assertEquals(400, e.code) }
        assertEquals(2, sent.size)
        assertTrue(support.supported)
    }
}
