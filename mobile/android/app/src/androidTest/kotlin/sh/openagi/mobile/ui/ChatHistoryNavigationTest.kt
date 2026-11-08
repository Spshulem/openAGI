package sh.openagi.mobile.ui

import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Rule
import org.junit.Test
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.ui.theme.OpenAGITheme
import java.time.Instant

class ChatHistoryNavigationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun selectingAnOlderResultStopsFollowingNewReplies() {
        lateinit var conversation: ChatConversationState
        compose.setContent {
            val scope = rememberCoroutineScope()
            conversation = androidx.compose.runtime.remember {
                ChatConversationState(scope).apply {
                    messages.value = (0L until 60L).map { ChatEntry.User(it, Instant.EPOCH, "History message $it") }
                }
            }
            OpenAGITheme {
                ChatScreen(LocalContext.current, Credentials("https://agent.example", "mobile:fixture", "fixture"),
                    streamAttached = true, conversationState = conversation)
            }
        }
        compose.onNodeWithText("History").performClick()
        compose.onNodeWithText("Search saved messages").performTextInput("message 0")
        compose.onNodeWithText("History message 0").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("History message 0").assertIsDisplayed()
        compose.runOnIdle {
            conversation.messages.value += ChatEntry.Assistant(60L, Instant.EPOCH, "A new reply", streaming = false)
        }
        compose.onNodeWithText("History message 0").assertIsDisplayed()
        compose.onNodeWithText("A new reply").assertDoesNotExist()
    }
}
