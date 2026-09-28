package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.ConversationMessage
import sh.openagi.mobile.protocol.ConversationPage
import java.nio.file.Files
import java.time.Instant
import sh.openagi.mobile.store.ChatHistoryStore

class ChatHistoryMergeTest {
    private val me = "mobile:me"
    private val t = Instant.parse("2026-09-28T15:00:00Z")

    private fun user(id: String, text: String, node: String? = me, name: String? = "Pixel") =
        ConversationMessage(id, "user", text, t, node, name)
    private fun reply(id: String, text: String) = ConversationMessage(id, "assistant", text, t)
    private fun page(vararg messages: ConversationMessage, nextBefore: String? = null) =
        ConversationPage("agent", messages.toList(), nextBefore)

    private fun ids(start: Long): () -> Long { var next = start; return { next++ } }
    private fun texts(entries: List<ChatEntry>) = entries.map {
        when (it) {
            is ChatEntry.User -> "user:${it.text}"
            is ChatEntry.Assistant -> "assistant:${it.text}${if (it.streaming) "…" else ""}${if (it.failed) "!" else ""}"
        }
    }

    @Test
    fun theServerThreadReplacesAnEmptyConversationAndNamesOtherDevices() {
        val merged = ChatHistoryMerge.merge(
            emptyList(),
            page(user("m1", "from the glasses", "g2-1", "Glasses"), reply("m2", "hi"), user("m3", "from me")),
            me, ids(0),
        )
        assertEquals(listOf("user:from the glasses", "assistant:hi", "user:from me"), texts(merged))
        assertEquals("Glasses", (merged[0] as ChatEntry.User).sourceName)
        assertEquals(null, (merged[2] as ChatEntry.User).sourceName)
        assertEquals(listOf("m1", "m2", "m3"), merged.map { it.serverId })
        assertEquals(listOf(0L, 1L, 2L), merged.map { it.id })
    }

    @Test
    fun linesAlreadyShownKeepTheirIds() {
        val first = ChatHistoryMerge.merge(emptyList(), page(user("m1", "a"), reply("m2", "b")), me, ids(0))
        val second = ChatHistoryMerge.merge(first, page(user("m1", "a"), reply("m2", "b"), user("m3", "c", "g2-1", "Glasses")), me, ids(10))
        assertEquals(listOf(0L, 1L, 10L), second.map { it.id })
    }

    @Test
    fun aReplyStillStreamingStaysAfterItsConfirmedQuestion() {
        val local = listOf(
            ChatEntry.User(5, t, "what's up"),
            ChatEntry.Assistant(6, t, "Work", streaming = true, retryText = "what's up"),
        )
        val merged = ChatHistoryMerge.merge(local, page(reply("m0", "earlier"), user("m1", "what's up")), me, ids(20))
        assertEquals(listOf("assistant:earlier", "user:what's up", "assistant:Work…"), texts(merged))
        assertEquals(6L, merged.last().id)
    }

    @Test
    fun aFinishedExchangeIsReplacedByTheServerCopy() {
        val local = listOf(
            ChatEntry.User(5, t, "hello"),
            ChatEntry.Assistant(6, t, "Hi there", streaming = false),
        )
        val merged = ChatHistoryMerge.merge(local, page(user("m1", "hello"), reply("m2", "Hi there")), me, ids(20))
        assertEquals(listOf("user:hello", "assistant:Hi there"), texts(merged))
        assertTrue(merged.all { it.serverId != null })
    }

    @Test
    fun aSendTheDaemonNeverStoredKeepsItsTryAgain() {
        val local = listOf(
            ChatEntry.User(5, t, "lost"),
            ChatEntry.Assistant(6, t, "Can't reach OpenAGI.", streaming = false, failed = true, retryText = "lost"),
        )
        val merged = ChatHistoryMerge.merge(local, page(user("m1", "other", "g2-1", "Glasses")), me, ids(20))
        assertEquals(listOf("user:other", "user:lost", "assistant:Can't reach OpenAGI.!"), texts(merged))
        assertEquals("lost", (merged.last() as ChatEntry.Assistant).retryText)
    }

    @Test
    fun aFailureTheDaemonRecordedShowsTheDaemonsCopy() {
        val local = listOf(
            ChatEntry.User(5, t, "hard one"),
            ChatEntry.Assistant(6, t, "OpenAGI couldn't reply.", streaming = false, failed = true, retryText = "hard one"),
        )
        val merged = ChatHistoryMerge.merge(local, page(user("m1", "hard one"), reply("m2", "I couldn't complete that request: budget")), me, ids(20))
        assertEquals(listOf("user:hard one", "assistant:I couldn't complete that request: budget"), texts(merged))
    }

    // The same words from another device, or an older identical line, never
    // stand in for this phone's unconfirmed send.
    @Test
    fun onlyAnUnclaimedLineFromThisPhoneConfirmsASend() {
        val shown = ChatHistoryMerge.merge(emptyList(), page(user("m1", "yes")), me, ids(0))
        val local = shown + ChatEntry.User(9, t, "yes") + ChatEntry.Assistant(10, t, "", streaming = true, retryText = "yes")
        val merged = ChatHistoryMerge.merge(local, page(user("m1", "yes"), user("m2", "yes", "g2-1", "Glasses")), me, ids(20))
        assertEquals(listOf("user:yes", "user:yes", "user:yes", "assistant:…"), texts(merged))
        assertEquals(listOf("m1", "m2", null, null), merged.map { it.serverId })
    }

    // Lines cached before shared threads existed belonged to the phone's own
    // old conversation; the shared thread is what is shown now.
    @Test
    fun oldFinishedCacheLinesGiveWayToTheSharedThread() {
        val local = listOf(ChatEntry.User(0, t, "old"), ChatEntry.Assistant(1, t, "old reply", streaming = false))
        val merged = ChatHistoryMerge.merge(local, page(user("m1", "new")), me, ids(5))
        assertEquals(listOf("user:new"), texts(merged))
    }

    @Test
    fun olderCachedLinesStayOnlyWhenTheyJoinThePage() {
        val cached = ChatHistoryMerge.merge(emptyList(), page(user("m1", "one"), reply("m2", "two"), user("m3", "three")), me, ids(0))
        val joined = ChatHistoryMerge.merge(cached, page(user("m3", "three"), reply("m4", "four"), nextBefore = "m3"), me, ids(10))
        assertEquals(listOf("user:one", "assistant:two", "user:three", "assistant:four"), texts(joined))
        val gap = ChatHistoryMerge.merge(cached, page(user("m8", "eight"), nextBefore = "m8"), me, ids(10))
        assertEquals(listOf("user:eight"), texts(gap))
        // A complete page (no older cursor) is the whole thread.
        val whole = ChatHistoryMerge.merge(cached, page(user("m3", "three")), me, ids(10))
        assertEquals(listOf("user:three"), texts(whole))
    }

    @Test
    fun theServerIdAndSenderSurviveTheOfflineCache() {
        val dir = Files.createTempDirectory("chat-merge-cache").toFile()
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)
        val state = ChatConversationState(scope, ChatHistoryStore(dir, "chat"), me, kotlinx.coroutines.Dispatchers.Unconfined, thread = "agent")
        state.messages.value = ChatHistoryMerge.merge(emptyList(), page(user("m1", "hey", "g2-1", "Glasses"), reply("m2", "yo")), me, ids(0))
        state.persist()
        val restored = ChatConversationState(scope, ChatHistoryStore(dir, "chat"), me, thread = "agent").messages.value
        assertEquals(listOf("m1", "m2"), restored.map { it.serverId })
        assertEquals("Glasses", (restored[0] as ChatEntry.User).sourceName)
    }
}
