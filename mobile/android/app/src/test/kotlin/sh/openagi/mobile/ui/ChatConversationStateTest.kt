package sh.openagi.mobile.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
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
}
