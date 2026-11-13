package sh.openagi.mobile.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.fallback.FallbackChatScreen
import sh.openagi.mobile.protocol.PairingPayload

// Used on first launch and from Settings. Replaying setup only changes the
// screen: enrollment remains an explicit action in PairingScreen.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OnboardingScreen(
    context: Context,
    prefill: PairingPayload?,
    onPaired: () -> Unit,
    onClose: (() -> Unit)? = null,
    onUsePhone: (() -> Unit)? = null,
    localStarting: Boolean = false,
    localError: String? = null,
) {
    var connecting by rememberSaveable(prefill?.code) { mutableStateOf(prefill != null) }
    var showingLocalChat by rememberSaveable { mutableStateOf(false) }

    if (connecting) {
        PairingScreen(context, prefill, onPaired, onCancel = { connecting = false })
        return
    }
    BackHandler(enabled = onClose != null) { onClose?.invoke() }
    if (showingLocalChat) FallbackChatScreen(context) { showingLocalChat = false }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("OpenAGI") },
                actions = {
                    if (onClose != null) TextButton(onClick = onClose) { Text("Return to app") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())
                .padding(20.dp).testTag("setup-welcome"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 600.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text("Welcome to OpenAGI", style = MaterialTheme.typography.headlineMedium)
                Text("Choose where to chat, connect a model or server, then send your first message. No OpenAGI account is required.")

                Text("On this phone", style = MaterialTheme.typography.titleLarge)
                Text("Tasks, Today, Inbox and conversations work on this phone without a server. Gemini Nano runs on supported phones; model setup checks support and shows download progress.")
                Button(onClick = { onUsePhone?.invoke() ?: run { showingLocalChat = true } },
                    enabled = !localStarting, modifier = Modifier.fillMaxWidth()) {
                    Text(if (localStarting) "Starting phone agent…" else "Chat on this phone")
                }
                localError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text("Your phone workspace is separate from your server. Connect a server for its tasks, integrations and shared history.", style = MaterialTheme.typography.bodySmall)

                Text("Use your existing agent", style = MaterialTheme.typography.titleLarge)
                Text("Connect to OpenAGI on your Mac or main server for shared chat, Tasks, Inbox, Today and Supervisor.")
                OutlinedButton(onClick = { connecting = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("Connect to a server")
                }

                Text("How to connect", style = MaterialTheme.typography.titleLarge)
                Text("Wi-Fi: update and restart the desktop app or daemon, then use Find servers on the next screen. Both devices must be on the same local network.")
                Text("Tailscale: copy your main server's DNS name from its Tailscale device entry. Enter that address on the next screen; Wi-Fi announcements don't cross Tailscale.")
                Text("Pairing code: use Connect a phone… in the Mac app, or Nodes → Connect a phone on your main server's dashboard. The next screen also shows the command to run on main.")

                if (onClose != null) {
                    Text("Your pairing, saved models and conversations stay saved. Return to app leaves setup without changing them.", style = MaterialTheme.typography.bodySmall)
                }
                Text("You can replay this welcome and setup from Settings → Run setup again.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
