package sh.openagi.mobile.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.store.ChatHistoryStore
import java.nio.file.Files
import java.time.Instant

class ChatConversationStateTest {
    // ChatScreen leaves composition on every tab switch. The conversation now
    // lives on this holder, which MainActivity keeps per pairing, so a second
    // ChatScreen built over the same holder reads back what the first wrote.
    @Test
    fun theConversationOutlivesTheScreenThatWroteIt() {
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val chat = ChatConversationState(scope)
        val supervisor = ChatConversationState(scope)

        chat.messages.value = listOf(ChatEntry.User(0, Instant.EPOCH, "hello"))
        chat.nextId.value = 1
        chat.inputText.value = "half-typed"

        assertEquals(listOf("hello"), chat.messages.value.map { (it as ChatEntry.User).text })
        assertEquals(1L, chat.nextId.value)
        assertEquals("half-typed", chat.inputText.value)
        assertTrue("the supervisor thread is its own conversation", supervisor.messages.value.isEmpty())
        // Replies stream in the Activity's scope, not the screen's, so a tab
        // switch mid-reply does not cancel the stream.
        assertSame(scope, chat.scope)
    }

    // Folding the phone recreates the Activity and a process kill drops
    // everything in memory; the saved copy brings the conversation back.
    @Test
    fun aSavedConversationComesBackInANewHolder() {
        val dir = Files.createTempDirectory("chat-history").toFile()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val first = ChatConversationState(scope, ChatHistoryStore(dir, "supervisor"), "node-1", Dispatchers.Unconfined)
        first.messages.value = listOf(
            ChatEntry.User(0, Instant.EPOCH, "What needs me?"),
            ChatEntry.Assistant(1, Instant.EPOCH, "Two PRs.", streaming = false),
            ChatEntry.User(2, Instant.EPOCH, "And now?"),
            ChatEntry.Assistant(3, Instant.EPOCH, "Half a rep", streaming = true, retryText = "And now?"),
        )
        first.persist()

        val second = ChatConversationState(scope, ChatHistoryStore(dir, "supervisor"), "node-1")
        val restored = second.messages.value
        assertEquals(4, restored.size)
        assertEquals("Two PRs.", (restored[1] as ChatEntry.Assistant).text)
        // A reply still streaming when the app died comes back stopped, with Try again.
        val stopped = restored[3] as ChatEntry.Assistant
        assertFalse(stopped.streaming)
        assertTrue(stopped.failed)
        assertEquals("And now?", stopped.retryText)
        assertEquals(4L, second.nextId.value)
        // The Chat tab's conversation and another pairing's are separate.
        assertTrue(ChatConversationState(scope, ChatHistoryStore(dir, "chat"), "node-1").messages.value.isEmpty())
        assertTrue(ChatConversationState(scope, ChatHistoryStore(dir, "supervisor"), "node-2").messages.value.isEmpty())
    }

    @Test
    fun onlyTheNewestLinesAreKept() {
        val dir = Files.createTempDirectory("chat-history-cap").toFile()
        val store = ChatHistoryStore(dir, "chat")
        val many = (0 until ChatHistoryStore.MAX_ENTRIES + 25).map {
            sh.openagi.mobile.store.SavedChatEntry(it.toLong(), "user", Instant.EPOCH, "m$it")
        }
        store.save("node-1", many)
        val kept = store.load("node-1")
        assertEquals(ChatHistoryStore.MAX_ENTRIES, kept.size)
        assertEquals("m25", kept.first().text)
        store.delete()
        assertTrue(store.load("node-1").isEmpty())
    }
}
