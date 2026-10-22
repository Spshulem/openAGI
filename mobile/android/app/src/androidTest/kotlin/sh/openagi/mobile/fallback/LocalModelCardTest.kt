package sh.openagi.mobile.fallback

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.ui.theme.OpenAGITheme

@RunWith(AndroidJUnit4::class)
class LocalModelCardTest {
    @get:Rule val compose = createComposeRule()

    @Test fun modelIsNamedBeforeDownloadAndCancelRemainsAvailableDuringProgress() {
        compose.setContent {
            var working by remember { mutableStateOf(false) }
            var progress by remember { mutableStateOf<LocalModelProgress?>(null) }
            OpenAGITheme {
                LocalModelCard("Ready to download", progress, working, true, true,
                    onPrepare = { working = true; progress = LocalModelProgress(25_000_000, 100_000_000) },
                    onCancel = { working = false; progress = null })
            }
        }
        compose.onNodeWithText("Gemini Nano").assertIsDisplayed()
        compose.onNodeWithText("On-device model · managed by Google AICore").assertIsDisplayed()
        compose.onNodeWithText("Download Gemini Nano").performClick()
        compose.onNodeWithText("25% ·", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Cancel setup").assertIsEnabled().performClick()
        compose.onNodeWithText("Download Gemini Nano").assertIsDisplayed().assertIsEnabled()
    }

    @Test fun navigationRemainsUsableWhileWaitingForAICore() {
        var switched = false
        compose.setContent {
            OpenAGITheme {
                Column {
                    LocalModelCard("Checking Gemini Nano…", null, true, false, false, {}, {})
                    TextButton(onClick = { switched = true }) { Text("Choose OpenAI") }
                }
            }
        }
        compose.onNodeWithText("Checking Gemini Nano…").assertIsDisplayed()
        compose.onNodeWithText("Cancel setup").assertIsEnabled()
        compose.onNodeWithText("Choose OpenAI").performClick()
        compose.runOnIdle { assertTrue(switched) }
    }
}
