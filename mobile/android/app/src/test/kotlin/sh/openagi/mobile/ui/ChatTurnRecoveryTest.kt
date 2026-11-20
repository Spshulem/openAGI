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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.ConversationMessage
import sh.openagi.mobile.protocol.ConversationPage
import sh.openagi.mobile.protocol.InFlightTurn
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.store.ChatHistoryStore
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SseFrame
import sh.openagi.mobile.util.ErrorCopy
import java.io.IOException
import java.nio.file.Files
import java.time.Instant

// mobile/PROTOCOL.md §3.1 "Recovering a turn": a reply whose stream Android
// cut (backgrounded, network drop) is found again in history by its turn id,
// never resent; a send main never confirmed is offered again with the same id.
class ChatTurnRecoveryTest {
    private val now = Instant.parse("2026-11-20T10:00:00Z")

    private fun detached(id: String, at: Instant = now.minusSeconds(10)): List<ChatEntry> = listOf(
        ChatEntry.User(0, at, "plan my day", requestId = id),
        ChatEntry.Assistant(1, at, "", streaming = true, retryText = "plan my day", requestId = id, accepted = true, detached = true),
    )

    private fun line(id: String, role: String, text: String, turn: String?) = ConversationMessage(id, role, text, now, requestId = turn)

    private fun page(vararg lines: ConversationMessage, inFlight: List<String>? = emptyList()) =
        ConversationPage("agent", lines.toList(), null, inFlight?.map { InFlightTurn(it, "model") })

    // ─── What a lost reply has become ──────────────────────────────────────

    @Test
    fun aStillRunningTurnKeepsWorking() {
        val local = detached("android-1")
        assertEquals(local, ChatTurnRecovery.resolve(local, page(line("m1", "user", "plan my day", "android-1"), inFlight = listOf("android-1")), now))
    }

    @Test
    fun theStoredReplyReplacesTheWorkingLine() {
        val server = page(line("m1", "user", "plan my day", "android-1"), line("m2", "assistant", "Here's your day.", "android-1"))
        val result = ChatTurnRecovery.resolve(detached("android-1"), server, now)
        assertEquals("the placeholder goes; the merge already holds main's reply", 1, result.size)
    }

    @Test
    fun aTurnMainLostOffersARetryAsANewTurn() {
        val result = ChatTurnRecovery.resolve(detached("android-1"), page(line("m1", "user", "plan my day", "android-1")), now)
        val reply = result.last() as ChatEntry.Assistant
        assertTrue(reply.failed && reply.newRequestOnRetry)
        assertFalse(reply.streaming || reply.detached)
        assertEquals(ChatTurnRecovery.INTERRUPTED, reply.text)
    }

    @Test
    fun anOlderMainThatCannotListRunningTurnsIsWaitedOnUntilStale() {
        val server = page(line("m1", "user", "plan my day", null), inFlight = null)
        val waiting = detached("android-1")
        assertEquals(waiting, ChatTurnRecovery.resolve(waiting, server, now))
        val stale = ChatTurnRecovery.resolve(detached("android-1", now.minus(ChatTurnRecovery.STALE_AFTER).minusSeconds(1)), server, now)
        val reply = stale.last() as ChatEntry.Assistant
        assertTrue(reply.failed)
        assertFalse("a stale turn may still be running: retry follows it", reply.newRequestOnRetry)
    }

    // ─── Process death ─────────────────────────────────────────────────────

    @Test
    fun acceptedRepliesSurviveProcessDeathAsRecoveringNotStopped() {
        val dir = Files.createTempDirectory("chat-recovery").toFile()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val first = ChatConversationState(scope, ChatHistoryStore(dir, "agent"), "node-1", Dispatchers.Unconfined, thread = "agent")
        first.messages.value = listOf(
            ChatEntry.User(0, now, "plan my day", requestId = "android-2"),
            ChatEntry.Assistant(1, now, "Half", streaming = true, retryText = "plan my day", requestId = "android-2", accepted = true),
            ChatEntry.User(2, now, "and this", requestId = "android-3"),
            ChatEntry.Assistant(3, now, "", streaming = true, retryText = "and this", requestId = "android-3"),
            ChatEntry.User(4, now, "old", requestId = null),
            ChatEntry.Assistant(5, now, "Half", streaming = true, retryText = "old"),
        )
        first.persist()

        val restored = ChatConversationState(scope, ChatHistoryStore(dir, "agent"), "node-1", thread = "agent").messages.value
        val recovering = restored[1] as ChatEntry.Assistant
        assertTrue(recovering.streaming && recovering.detached && recovering.accepted)
        assertEquals("android-2", recovering.requestId)
        assertEquals(ChatTurnRecovery.STILL_WORKING, recovering.activity)
        val unconfirmed = restored[3] as ChatEntry.Assistant
        assertTrue(unconfirmed.failed && unconfirmed.autoRetry)
        assertEquals("android-3", unconfirmed.requestId)
        assertEquals(ChatTurnRecovery.NOT_SENT, unconfirmed.text)
        val stopped = restored[5] as ChatEntry.Assistant
        assertEquals("Reply stopped when the app closed.", stopped.failureDetail)
        assertFalse(stopped.autoRetry)
        assertEquals("android-2", (restored[0] as ChatEntry.User).requestId)
    }

    // ─── Decoding ───────────────────────────────────────────────────────────

    @Test
    fun historyDecodesTurnIdsFailuresAndRunningTurns() {
        val json = """
            {"thread":"agent","nextBefore":null,
             "messages":[{"id":"m1","role":"user","text":"hi","at":"2026-11-20T10:00:00.000Z","requestId":"android-4"},
                         {"id":"m2","role":"assistant","text":"I couldn't…","at":"2026-11-20T10:00:01.000Z","requestId":"android-4","status":"failed"}],
             "inFlight":[{"requestId":"android-5","stage":"model","startedAt":"2026-11-20T10:00:02.000Z"}]}
        """.trimIndent()
        val decoded = ProtocolJson.json.decodeFromString(ConversationPage.serializer(), json)
        assertEquals(listOf("android-4", "android-4"), decoded.messages.map { it.requestId })
        assertEquals("failed", decoded.messages.last().status)
        assertEquals(listOf("android-5"), decoded.inFlight?.map { it.requestId })
        val older = ProtocolJson.json.decodeFromString(ConversationPage.serializer(), """{"thread":"agent","messages":[]}""")
        assertNull("an older main cannot say what is running", older.inFlight)
    }

    @Test
    fun mergeTiesALocalLineToMainsCopyByTurnId() {
        val local = listOf(ChatEntry.User(0, now, "plan my day ", requestId = "android-6"))
        val server = ConversationPage("agent", listOf(ConversationMessage("m1", "user", "Plan my day, please", now, "me", "Pixel", requestId = "android-6")))
        var id = 10L
        val merged = ChatHistoryMerge.merge(local, server, "me") { id++ }
        assertEquals(1, merged.size)
        assertEquals("m1", merged.single().serverId)
        assertEquals("android-6", (merged.single() as ChatEntry.User).requestId)
    }

    // ─── An older main and the turn id ────────────────────────────────────

    private data class Sent(val thread: String?, val requestId: String?)

    @Test
    fun anOlderMainRefusingTheTurnIdGetsTheSendAgainWithoutItKeepingTheThread() = runBlocking {
        val support = SharedThreadSupport()
        val s = state(support)
        val sent = mutableListOf<Sent>()
        val reply = SseFrame("final", "{\"reply\":\"ok\"}")
        val older: (String, String?, String?, String?, String?) -> Flow<SseFrame> = { _, _, _, thread, requestId ->
            sent += Sent(thread, requestId)
            if (requestId != null) flow { throw DaemonException.Server(400) } else flowOf(reply)
        }
        assertEquals(listOf(reply), s.messageStream("hi", null, null, "android-7", older).toList())
        assertEquals(listOf(Sent("agent", "android-7"), Sent("agent", null)), sent)
        assertFalse(support.turnIds)
        assertTrue("thread support is not blamed", support.supported)
        sent.clear()
        s.messageStream("again", null, null, "android-8", older).toList()
        assertEquals(listOf(Sent("agent", null)), sent)
    }

    // ─── Whole turns ────────────────────────────────────────────────────────

    private fun state(support: SharedThreadSupport = SharedThreadSupport()) =
        ChatConversationState(CoroutineScope(Dispatchers.Unconfined), nodeId = "me", thread = "agent", threadSupport = support)
            .also {
                it.refreshRetryDelaysMs = listOf(0L)
                it.recoveryDelaysMs = listOf(0L)
            }

    private fun transport(
        send: (String, String?, String?, String?, String?) -> Flow<SseFrame>,
        fetch: suspend (String, String?) -> ConversationPage,
    ) = ChatTransport(send = send, fetch = fetch, refusal = { ErrorCopy.Message("Refused.", "Try again.") })

    @Test
    fun anAcceptedTurnWhoseStreamDropsIsFoundInHistoryWithoutResending() = runBlocking {
        val s = state()
        val turns = mutableListOf<String?>()
        var pages = 0
        val chat = transport(
            send = { _, _, _, _, requestId ->
                turns += requestId
                flowOf(SseFrame("session", "{\"id\":\"devices:agent:main\",\"messageCount\":1}"))
            },
            fetch = { _, _ ->
                pages += 1
                val turn = turns.lastOrNull()
                val user = ConversationMessage("m1", "user", "plan my day", now, "me", "Pixel", requestId = turn)
                if (turn == null) {
                    ConversationPage("agent", emptyList(), null, emptyList())
                } else if (pages <= 2) {
                    ConversationPage("agent", listOf(user), null, listOf(InFlightTurn(turn)))
                } else {
                    ConversationPage("agent", listOf(user, ConversationMessage("m2", "assistant", "Planned.", now, requestId = turn)), null, emptyList())
                }
            },
        )
        s.resume(chat).join()
        assertTrue(s.start("plan my day", chat))
        assertEquals(1, turns.size)
        assertTrue("each send names its turn", turns.single()!!.startsWith("android-"))
        assertEquals(listOf("plan my day", "Planned."), s.messages.value.map { if (it is ChatEntry.User) it.text else (it as ChatEntry.Assistant).text })
        assertFalse(s.messages.value.any { it is ChatEntry.Assistant && it.detached })
        assertEquals("never resent", 1, turns.size)
    }

    @Test
    fun aSendMainNeverConfirmedIsResentOnceWithTheSameTurnId() = runBlocking {
        val s = state()
        val turns = mutableListOf<String?>()
        val chat = transport(
            send = { _, _, _, _, requestId ->
                turns += requestId
                if (turns.size == 1) {
                    flow { throw DaemonException.Transport(IOException("connection reset")) }
                } else {
                    flowOf(SseFrame("session", "{\"id\":\"devices:agent:main\"}"), SseFrame("final", "{\"reply\":\"Done.\"}"))
                }
            },
            // Main stores the turn once it is confirmed (the second send).
            fetch = { _, _ ->
                val stored = if (turns.size < 2) emptyList() else listOf(
                    ConversationMessage("m1", "user", "hello", now, "me", "Pixel", requestId = turns[1]),
                    ConversationMessage("m2", "assistant", "Done.", now, requestId = turns[1]),
                )
                ConversationPage("agent", stored, null, emptyList())
            },
        )
        s.start("hello", chat)
        val unconfirmed = s.messages.value.last() as ChatEntry.Assistant
        assertTrue(unconfirmed.failed && unconfirmed.autoRetry)
        assertEquals(ChatTurnRecovery.NOT_SENT, unconfirmed.text)

        s.resume(chat).join()
        assertEquals(2, turns.size)
        assertEquals("the same turn, so main cannot run it twice", turns[0], turns[1])
        assertEquals(listOf("hello", "Done."), s.messages.value.map { if (it is ChatEntry.User) it.text else (it as ChatEntry.Assistant).text })
        s.resume(chat).join()
        assertEquals("resent once, not on every return", 2, turns.size)
    }

    // A main without shared history (404) can't find a lost reply again.
    @Test
    fun anAcceptedReplyOnAMainWithoutHistoryFallsBackToTheOldCopy() = runBlocking {
        val s = state()
        var sends = 0
        val chat = transport(
            send = { _, _, _, _, _ ->
                sends += 1
                flowOf(SseFrame("session", "{\"id\":\"devices:agent:main\"}"))
            },
            fetch = { _, _ -> throw DaemonException.NotFound() },
        )
        s.start("hello", chat)
        val reply = s.messages.value.last() as ChatEntry.Assistant
        assertTrue(reply.failed)
        assertFalse(reply.detached || reply.autoRetry)
        assertEquals("Reply stopped early.", reply.text)
        s.resume(chat).join()
        assertEquals(1, sends)
    }

    @Test
    fun aMainWithoutTurnIdsKeepsTheOldCopyAndNoAutomaticResend() = runBlocking {
        val support = SharedThreadSupport().apply { turnIds = false }
        val s = state(support)
        var sends = 0
        val chat = transport(
            send = { _, _, _, _, requestId ->
                sends += 1
                assertNull(requestId)
                flowOf(SseFrame("delta", "{\"text\":\"Hal\"}"))
            },
            fetch = { _, _ -> throw DaemonException.NotFound() },
        )
        s.start("hello", chat)
        val reply = s.messages.value.last() as ChatEntry.Assistant
        assertTrue(reply.failed)
        assertFalse(reply.autoRetry)
        assertEquals("Reply stopped early.", reply.text)
        s.resume(chat).join()
        assertEquals(1, sends)
    }
}
