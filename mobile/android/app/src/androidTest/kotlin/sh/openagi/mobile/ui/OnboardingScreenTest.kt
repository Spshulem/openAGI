package sh.openagi.mobile.ui

import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.ui.theme.OpenAGITheme

@RunWith(AndroidJUnit4::class)
class OnboardingScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun firstLaunchExplainsLocalChatAndServerDiscoveryBeforePairing() {
        compose.setContent {
            OpenAGITheme { OnboardingScreen(LocalContext.current, null, {}) }
        }
        compose.onNodeWithText("Welcome to OpenAGI").assertIsDisplayed()
        compose.onNodeWithText("Chat on this phone").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("Connect to a server").performScrollTo().performClick()
        compose.onNodeWithText("Pair with OpenAGI").assertIsDisplayed()
        compose.onNodeWithText("How to get a code").assertExists()
        compose.onNodeWithText("Back to setup").performScrollTo().performClick()
        compose.onNodeWithText("Welcome to OpenAGI").assertIsDisplayed()
    }

    @Test fun replayedSetupCanReturnWithoutEnrolling() {
        var returned = false
        compose.setContent {
            OpenAGITheme {
                OnboardingScreen(LocalContext.current, null,
                    onPaired = { error("Viewing setup must not enroll") },
                    onClose = { returned = true })
            }
        }
        compose.onNodeWithText("Connect to a server").performScrollTo().performClick()
        compose.onNodeWithText("Back to setup").performScrollTo().performClick()
        compose.onNodeWithText("Return to app").performClick()
        compose.runOnIdle { assertTrue(returned) }
    }
}
