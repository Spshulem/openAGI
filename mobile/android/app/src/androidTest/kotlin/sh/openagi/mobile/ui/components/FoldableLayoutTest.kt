@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package sh.openagi.mobile.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.ui.theme.OpenAGITheme

@RunWith(AndroidJUnit4::class)
class FoldableLayoutTest {
    @get:Rule val compose = createComposeRule()

    private val size = mutableStateOf(DpSize(359.dp, 780.dp))
    private val fold = mutableStateOf<FoldInfo?>(null)

    private fun workspace() {
        compose.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(size.value)) {
                OpenAGITheme {
                    CompositionLocalProvider(LocalFoldInfo provides fold.value) {
                        AdaptiveAppScaffold(AppTab.TODAY, 2, false, {}, supportingPane = { Text("Chat fixture") }) {
                            var count by remember { mutableIntStateOf(0) }
                            Button(onClick = { count++ }) { Text("Work fixture $count") }
                        }
                    }
                }
            }
        }
    }

    @Test fun coverToUnfoldedKeepsTheOpenWorkState() {
        workspace()
        compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
        compose.onNodeWithTag("supporting-pane").assertDoesNotExist()
        compose.onNodeWithText("Work fixture 0").performClick()
        screenshot("cover")

        compose.runOnIdle { size.value = DpSize(1000.dp, 900.dp) }
        compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
        compose.onNodeWithText("Work fixture 1").assertIsDisplayed()
        compose.onNodeWithText("Chat fixture").assertIsDisplayed()
        screenshot("unfolded")
    }

    @Test fun bookPanesLeaveTheVerticalHingeClear() {
        size.value = DpSize(1000.dp, 900.dp)
        fold.value = FoldInfo(PaneBounds(490f, 0f, 510f, 900f), FoldAxis.VERTICAL)
        workspace()
        val main = compose.onNodeWithTag("main-pane").fetchSemanticsNode().boundsInRoot
        val chat = compose.onNodeWithTag("supporting-pane").fetchSemanticsNode().boundsInRoot
        assertTrue("The hinge must separate the panes", main.right < chat.left)
        compose.onNodeWithText("Chat fixture").assertIsDisplayed()
        screenshot("book")
    }

    @Test fun tabletopPlacesWorkAboveChatAndKeepsNavigationBelow() {
        size.value = DpSize(1000.dp, 900.dp)
        fold.value = FoldInfo(PaneBounds(0f, 440f, 1000f, 460f), FoldAxis.HORIZONTAL)
        workspace()
        val main = compose.onNodeWithTag("main-pane").fetchSemanticsNode().boundsInRoot
        val chat = compose.onNodeWithTag("supporting-pane").fetchSemanticsNode().boundsInRoot
        assertTrue("The horizontal hinge must remain clear", main.bottom < chat.top)
        compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
        compose.onNodeWithTag("navigation-rail").assertDoesNotExist()
        screenshot("tabletop")
    }

    @Test fun foldingAConversationKeepsItsDraftAndInputFocus() {
        size.value = DpSize(1000.dp, 900.dp)
        compose.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(size.value)) {
                OpenAGITheme {
                    CompositionLocalProvider(LocalFoldInfo provides fold.value) {
                        FoldAwareChatColumn(messages = { Text("Conversation fixture") }, composer = {
                            var draft by remember { mutableStateOf("") }
                            BasicTextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth()
                                .heightIn(min = 56.dp).testTag("draft"))
                        })
                    }
                }
            }
        }
        compose.onNodeWithTag("draft").performTextInput("Keep this draft")
        compose.runOnIdle { fold.value = FoldInfo(PaneBounds(0f, 440f, 1000f, 460f), FoldAxis.HORIZONTAL) }
        compose.onNodeWithTag("draft").assertTextEquals("Keep this draft").assertIsFocused()
        val messages = compose.onNodeWithText("Conversation fixture").fetchSemanticsNode().boundsInRoot
        val input = compose.onNodeWithTag("draft").fetchSemanticsNode().boundsInRoot
        assertTrue(messages.bottom < input.top)
        screenshot("chat-tabletop")
        compose.runOnIdle { fold.value = null }
        compose.onNodeWithTag("draft").assertTextEquals("Keep this draft").assertIsFocused()
    }

    private fun screenshot(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "foldable-screenshots").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
