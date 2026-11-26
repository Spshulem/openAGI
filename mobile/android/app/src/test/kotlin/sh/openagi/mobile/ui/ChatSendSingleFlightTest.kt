package sh.openagi.mobile.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.ConversationMessage
import sh.openagi.mobile.protocol.ConversationPage
import sh.openagi.mobile.protocol.InFlightTurn
import sh.openagi.mobile.protocol.TurnState
import sh.openagi.mobile.protocol.TurnStates
import sh.openagi.mobile.store.ChatHistoryStore
import sh.openagi.mobile.store.SavedChatEntry
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SseFrame
import sh.openagi.mobile.util.ErrorCopy
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.Instant

// Reconnecting must never put the owner's unconfirmed sends on the wire in
// a burst: one turn at a time, nothing resent while main still runs one of
// ours, and main asked (GET /conversations/:thread/turns) before a resend.
// A StandardTestDispatcher runs launched work only on runCurrent(), which is
// what exposes a check-then-launch gap.
@OptIn(ExperimentalCoroutinesApi::class)
class ChatSendSingleFlightTest {
    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)
    private val at = Instant.now().minusSeconds(10)

    // A synthetic main: stores a turn when it finishes it, and answers the
    // turns route from what it holds unless a test says otherwise.
    private class FakeMain {
        val posts = mutableListOf<String?>()
        var open = 0
        var maxOpen = 0
        var gate: CompletableDeferred<Unit>? = null
        var dropBeforeAccept = false
        var conflict = false
        val stored = mutableListOf<ConversationMessage>()
        var inFlight: List<String> = emptyList()
        var states: Map<String, String> = emptyMap()
        var turnsMissing = false
        var turnQueries = 0
        var onPost: (String?) -> Unit = {}

        fun send(text: String, requestId: String?): Flow<SseFrame> = flow {
            posts += requestId
            onPost(requestId)
            open += 1
            maxOpen = maxOf(maxOpen, open)
            try {
                gate?.await()
                if (conflict) throw DaemonException.Server(409)
                if (dropBeforeAccept) throw DaemonException.Transport(IOException("connection reset"))
                emit(SseFrame("session", "{\"id\":\"devices:supervisor:main\"}"))
                val n = stored.size
                stored += ConversationMessage("m$n", "user", text, Instant.now(), "me", "Pixel", requestId = requestId)
                stored += ConversationMessage("m${n + 1}", "assistant", "Done: $text", Instant.now(), requestId = requestId)
                emit(SseFrame("final", "{\"reply\":\"Done: $text\"}"))
            } finally {
                open -= 1
            }
        }

        fun page() = ConversationPage("supervisor", stored.toList(), null, inFlight.map { InFlightTurn(it, "model") })

        fun turns(ids: List<String>): TurnStates {
            turnQueries += 1
            if (turnsMissing) throw DaemonException.NotFound()
            return TurnStates(
                "supervisor", "main", inFlight.map { InFlightTurn(it) },
                ids.map { id -> TurnState(id, states[id] ?: if (stored.any { it.role == "assistant" && it.requestId == id }) "done" else "unknown") },
            )
        }

        fun transport(withTurns: Boolean = true) = ChatTransport(
            send = { text, _, _, _, requestId -> send(text, requestId) },
            fetch = { _, _ -> page() },
            turns = if (withTurns) { _, ids -> turns(ids) } else null,
            refusal = { ErrorCopy.Message("Refused.", "Try again.") },
        )
    }

    private fun state(store: ChatHistoryStore? = null) =
        ChatConversationState(scope, store, "me", dispatcher, thread = "supervisor").also {
            it.refreshRetryDelaysMs = listOf(0L)
            // Far off, so runCurrent() never spins the recovery poll.
            it.recoveryDelaysMs = listOf(3_600_000L)
        }

    private fun unconfirmed(id: Long, text: String, turn: String): List<ChatEntry> = listOf(
        ChatEntry.User(id, at, text, requestId = turn),
        ChatEntry.Assistant(
            id + 1, at, ChatTurnRecovery.NOT_SENT, streaming = false, failed = true, failureDetail = ChatTurnRecovery.NOT_SENT_DETAIL,
            retryText = text, requestId = turn, autoRetry = true,
        ),
    )

    private fun detached(id: Long, text: String, turn: String): List<ChatEntry> = listOf(
        ChatEntry.User(id, at, text, requestId = turn),
        ChatEntry.Assistant(id + 1, at, "", streaming = true, retryText = text, requestId = turn, accepted = true, detached = true),
    )

    private fun ChatConversationState.with(vararg lines: List<ChatEntry>) = apply {
        messages.value = lines.flatMap { it }
        nextId.value = messages.value.maxOf { it.id } + 1
    }

    private fun ChatConversationState.reply(turn: String) =
        messages.value.last { it is ChatEntry.Assistant && it.requestId == turn } as ChatEntry.Assistant

    // ─── One turn on the wire ──────────────────────────────────────────────

    @Test
    fun overlappingResumePassesPostExactlyOneTurn() {
        val main = FakeMain().apply { gate = CompletableDeferred() }
        val s = state().with(unconfirmed(0, "first", "android-a"), unconfirmed(2, "second", "android-b"))
        val chat = main.transport()
        // Two passes, then a quick pause and resume, then the lifecycle
        // observer re-added replaying ON_RESUME: all before any of it runs.
        s.resume(chat)
        s.resume(chat)
        s.pause()
        s.resume(chat)
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a"), main.posts)
        assertEquals(1, main.maxOpen)
    }

    @Test
    fun aSecondSendOrRetryBeforeTheFirstRunsIsRefused() {
        val main = FakeMain().apply { gate = CompletableDeferred() }
        val s = state().with(unconfirmed(0, "older", "android-a"))
        val chat = main.transport()
        assertTrue(s.start("one", chat))
        assertFalse("busy is set before the launch runs", s.start("two", chat))
        assertFalse(s.retry(s.reply("android-a"), chat))
        scope.runCurrent()
        assertEquals(1, main.posts.size)
        assertEquals(1, main.maxOpen)
    }

    @Test
    fun twoUnconfirmedSendsAreResentOneAtATimeNeverTogether() {
        val main = FakeMain().apply { gate = CompletableDeferred() }
        val s = state().with(unconfirmed(0, "first", "android-a"), unconfirmed(2, "second", "android-b"))
        val chat = main.transport()
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a"), main.posts)
        // Back again while the first is still on the wire: nothing more.
        s.pause()
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a"), main.posts)
        main.gate!!.complete(Unit)
        scope.runCurrent()
        assertEquals("one automatic resend per pass", listOf<String?>("android-a"), main.posts)
        assertEquals("Done: first", s.reply("android-a").text)
        s.pause()
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a", "android-b"), main.posts)
        assertEquals(1, main.maxOpen)
        assertEquals("Done: second", s.reply("android-b").text)
    }

    // ─── Not while main still runs one of ours ─────────────────────────────

    @Test
    fun nothingIsResentWhileAnOwnTurnIsStillRunningOnMain() {
        val main = FakeMain().apply { inFlight = listOf("android-a") }
        val s = state().with(detached(0, "first", "android-a"), unconfirmed(2, "second", "android-b"))
        s.resume(main.transport())
        scope.runCurrent()
        assertTrue(main.posts.isEmpty())
        assertTrue(s.reply("android-a").detached)
        assertTrue(s.reply("android-b").autoRetry)
    }

    @Test
    fun nothingIsResentWhileMainRunsAnyTurnInTheThread() {
        val main = FakeMain().apply { inFlight = listOf("g2-turn") }
        val s = state().with(unconfirmed(0, "second", "android-b"))
        val chat = main.transport()
        s.resume(chat)
        scope.runCurrent()
        assertTrue(main.posts.isEmpty())
        main.inFlight = emptyList()
        s.pause()
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-b"), main.posts)
    }

    // ─── Main asked first ─────────────────────────────────────────────────

    @Test
    fun aSendMainAlreadyFinishedIsNotResentAndIsFoundInHistory() {
        // The answer was lost after main accepted it; this refresh raced
        // ahead of main storing it.
        val main = FakeMain().apply { states = mapOf("android-a" to "done") }
        val s = state().with(unconfirmed(0, "first", "android-a"))
        val chat = main.transport()
        s.resume(chat)
        scope.runCurrent()
        assertTrue(main.posts.isEmpty())
        val waiting = s.reply("android-a")
        assertTrue(waiting.detached && !waiting.failed && !waiting.autoRetry)
        main.stored += ConversationMessage("m0", "user", "first", at, "me", "Pixel", requestId = "android-a")
        main.stored += ConversationMessage("m1", "assistant", "Done: first", at, requestId = "android-a")
        s.requestRefresh(chat.fetch)
        scope.runCurrent()
        assertEquals(listOf("first", "Done: first"), s.messages.value.map { if (it is ChatEntry.User) it.text else (it as ChatEntry.Assistant).text })
        assertTrue(main.posts.isEmpty())
    }

    @Test
    fun aSendMainIsRunningOrHoldingIsWaitedOnNotResent() {
        for (stage in listOf("running", "queued")) {
            val main = FakeMain().apply {
                states = mapOf("android-a" to stage)
                if (stage == "running") inFlight = listOf("android-a")
            }
            val s = state().with(unconfirmed(0, "first", "android-a"), unconfirmed(2, "second", "android-b"))
            s.resume(main.transport())
            scope.runCurrent()
            assertTrue(stage, main.posts.isEmpty())
            assertEquals(stage, ChatTurnRecovery.STILL_WORKING, s.reply("android-a").activity)
            assertTrue(stage, s.reply("android-a").detached)
            assertTrue("the next one waits its turn", s.reply("android-b").autoRetry)
            s.pause()
        }
    }

    @Test
    fun failedAndInterruptedSendsWaitForThePersonAndRetryAsNewTurns() {
        val main = FakeMain().apply { states = mapOf("android-a" to "failed", "android-b" to "interrupted") }
        val s = state().with(unconfirmed(0, "first", "android-a"), unconfirmed(2, "second", "android-b"))
        val chat = main.transport()
        s.resume(chat)
        scope.runCurrent()
        assertTrue(main.posts.isEmpty())
        for (turn in listOf("android-a", "android-b")) {
            val reply = s.reply(turn)
            assertTrue(reply.failed && reply.newRequestOnRetry && !reply.autoRetry)
        }
        assertEquals(ChatTurnRecovery.INTERRUPTED, s.reply("android-b").text)
        s.retry(s.reply("android-b"), chat)
        scope.runCurrent()
        assertNotEquals("android-b", main.posts.single())
    }

    @Test
    fun aSendMainNeverTookIsResentOnceWithTheSameId() {
        val main = FakeMain().apply { dropBeforeAccept = true }
        val s = state().with(unconfirmed(0, "first", "android-a"))
        val chat = main.transport()
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a"), main.posts)
        val lost = s.reply("android-a")
        assertTrue(lost.failed && lost.autoResent)
        assertFalse("a second loss waits for the person", lost.autoRetry)
        s.pause()
        s.resume(chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a"), main.posts)
        // The person's own Try again keeps the id: main never took it.
        main.dropBeforeAccept = false
        s.retry(lost, chat)
        scope.runCurrent()
        assertEquals(listOf<String?>("android-a", "android-a"), main.posts)
        assertEquals("Done: first", s.reply("android-a").text)
    }

    @Test
    fun aSendWhoseOneResendIsUsedUpIsStillCheckedAndFoundWhenMainTookIt() {
        val main = FakeMain().apply { dropBeforeAccept = true }
        val s = state().with(unconfirmed(0, "first", "android-a"))
        val chat = main.transport()
        s.resume(chat)
        scope.runCurrent()
        val lost = s.reply("android-a")
        assertTrue(lost.failed && lost.autoResent && !lost.autoRetry)
        // That resend did reach main, which queued it before the drop.
        main.states = mapOf("android-a" to "queued")
        val queries = main.turnQueries
        s.pause()
        s.resume(chat)
        scope.runCurrent()
        assertTrue("still asked about", main.turnQueries > queries)
        assertEquals("never posted again", listOf<String?>("android-a"), main.posts)
        val found = s.reply("android-a")
        assertTrue(found.detached && !found.failed)
        assertEquals(ChatTurnRecovery.STILL_WORKING, found.activity)
        s.pause()
    }

    @Test
    fun anOlderMainWithoutTheTurnsRouteGetsAtMostOneResend() {
        for (withTurns in listOf(true, false)) {
            val main = FakeMain().apply {
                turnsMissing = true
                dropBeforeAccept = true
            }
            val dir = Files.createTempDirectory("chat-single-flight").toFile()
            val s = state(ChatHistoryStore(dir, "supervisor")).with(unconfirmed(0, "first", "android-a"), unconfirmed(2, "second", "android-b"))
            val chat = main.transport(withTurns)
            repeat(3) {
                s.pause()
                s.resume(chat)
                scope.runCurrent()
            }
            assertEquals(listOf<String?>("android-a", "android-b"), main.posts)
            assertEquals(1, main.maxOpen)
            // And not again after a process restart.
            val restarted = state(ChatHistoryStore(dir, "supervisor"))
            restarted.resume(chat)
            scope.runCurrent()
            assertEquals(listOf<String?>("android-a", "android-b"), main.posts)
            s.pause()
            restarted.pause()
        }
    }

    @Test
    fun aRefusedTurnIdIsNeverUsedAgain() {
        val main = FakeMain().apply { conflict = true }
        val s = state()
        val chat = main.transport()
        s.start("first", chat)
        scope.runCurrent()
        val refused = s.messages.value.last() as ChatEntry.Assistant
        assertTrue(refused.failed && refused.newRequestOnRetry && !refused.autoRetry)
        main.conflict = false
        s.retry(refused, chat)
        scope.runCurrent()
        assertEquals(2, main.posts.size)
        assertNotEquals(main.posts[0], main.posts[1])
    }

    // ─── Process restart ─────────────────────────────────────────────────

    @Test
    fun aTurnIsOnDiskBeforeItIsPostedAndARestartKeepsTheRules() {
        val dir: File = Files.createTempDirectory("chat-single-flight").toFile()
        fun store() = ChatHistoryStore(dir, "supervisor")
        val main = FakeMain().apply { gate = CompletableDeferred() }
        var savedAtPost: SavedChatEntry? = null
        main.onPost = { turn -> savedAtPost = store().load("me").lastOrNull { it.role == "assistant" && it.requestId == turn } }
        val first = state(store())
        first.start("hello", main.transport())
        scope.runCurrent()
        val turn = main.posts.single()
        assertNotNull("saved before main saw it", savedAtPost)
        assertTrue(savedAtPost!!.autoRetry)

        // The process dies mid-send; main had taken the turn and holds it.
        main.onPost = {}
        main.states = mapOf(turn!! to "queued")
        val second = state(store())
        assertTrue(second.reply(turn).autoRetry)
        second.resume(main.transport())
        scope.runCurrent()
        assertEquals(1, main.posts.size)
        assertTrue(second.reply(turn).detached)
        second.pause()

        // Again, while main runs it: still waited on, still not resent.
        main.inFlight = listOf(turn)
        main.states = mapOf(turn to "running")
        val third = state(store())
        assertTrue(third.reply(turn).detached)
        third.resume(main.transport())
        scope.runCurrent()
        assertEquals(1, main.posts.size)
        third.pause()
    }

    // ─── The same words twice are two turns ──────────────────────────────

    @Test
    fun identicalTextSentTwiceIsTwoTurnsWithTwoIds() {
        val main = FakeMain()
        val s = state()
        val chat = main.transport()
        assertTrue(s.start("same", chat))
        scope.runCurrent()
        assertTrue(s.start("same", chat))
        scope.runCurrent()
        assertEquals(2, main.posts.size)
        assertNotEquals(main.posts[0], main.posts[1])
        val users = s.messages.value.filterIsInstance<ChatEntry.User>()
        assertEquals(listOf("same", "same"), users.map { it.text })
        assertEquals(main.posts, users.map { it.requestId })
    }

    @Test
    fun theTextFallbackNeverTiesTwoNamedTurnsTogether() {
        // Main stored only the second of two identical sends.
        val local = unconfirmed(0, "same", "android-a") + listOf(
            ChatEntry.User(2, at, "same", requestId = "android-b"),
            ChatEntry.Assistant(3, at, "", streaming = true, retryText = "same", requestId = "android-b"),
        )
        val page = ConversationPage("supervisor", listOf(ConversationMessage("m1", "user", "same", at, "me", "Pixel", requestId = "android-b")), null, emptyList())
        var id = 10L
        val merged = ChatHistoryMerge.merge(local, page, "me") { id++ }
        val first = merged.filterIsInstance<ChatEntry.User>().first { it.requestId == "android-a" }
        assertEquals("android-a stays unconfirmed, not claimed by android-b's copy", null, first.serverId)
        assertTrue(merged.any { it is ChatEntry.Assistant && it.requestId == "android-a" && it.autoRetry })
        assertEquals("m1", merged.filterIsInstance<ChatEntry.User>().single { it.requestId == "android-b" }.serverId)
    }
}
