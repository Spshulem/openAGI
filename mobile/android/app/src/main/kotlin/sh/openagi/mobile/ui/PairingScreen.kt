package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.PairingPayload
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.MobileNodeIdentity
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.sync.RefreshWorker
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException

// Shown before the phone has any Credentials. A person gets here one of two
// ways: they typed the six-digit code `openagi pair-phone` printed, or they
// tapped the `openagi://pair` link it also printed and the fields below
// arrive prefilled via MainActivity reading the launch intent through
// PairingPayload.from. Either way this drives the same enrollment.
@Composable
fun PairingScreen(
    context: Context,
    prefill: PairingPayload?,
    onPaired: () -> Unit,
) {
    var serverText by remember(prefill) { mutableStateOf(prefill?.serverUrl ?: "") }
    var codeText by remember(prefill) { mutableStateOf(prefill?.code ?: "") }
    var isPairing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Pair with OpenAGI", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            value = serverText,
            onValueChange = { serverText = it },
            label = { Text("Daemon address") },
            placeholder = { Text("http://mac.tail1234.ts.net:43210") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = codeText,
            onValueChange = { if (it.length <= 6) codeText = it },
            label = { Text("6-digit code") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        errorMessage?.let { message ->
            // Rendered verbatim: DaemonException's own message (including the
            // host allowlist's refusal, e.g. for 127.0.0.1) already tells the
            // user exactly what to change. No extra mapping layer here.
            Text(message, color = MaterialTheme.colorScheme.error)
        }
        Button(
            onClick = {
                errorMessage = null
                isPairing = true
                scope.launch {
                    try {
                        val nodeId = MobileNodeIdentity.newNodeId()
                        val nodeToken = MobileNodeIdentity.newToken()
                        val enrollment = DaemonClient.enroll(
                            server = serverText,
                            code = codeText,
                            nodeId = nodeId,
                            nodeToken = nodeToken,
                            name = "Android",
                        )
                        val credentials = Credentials(
                            server = serverText,
                            nodeId = enrollment.node.id,
                            token = enrollment.nodeToken,
                        )
                        Credentials.save(context, credentials)
                        RefreshWorker.schedule(context)
                        // Kick the first refresh so the day's tasks are already on
                        // disk by the time TodayScreen appears; failure here is
                        // not fatal to pairing itself, so it's not surfaced as a
                        // pairing error.
                        val client = DaemonClient(credentials.server, credentials.nodeId, credentials.token)
                        RefreshCoordinator(
                            client,
                            SnapshotStore(context.filesDir),
                            OutboundQueue(context.filesDir),
                        ).refresh()
                        onPaired()
                    } catch (error: DaemonException) {
                        errorMessage = error.message
                    } catch (error: Exception) {
                        errorMessage = "Could not pair: ${error.message}"
                    } finally {
                        isPairing = false
                    }
                }
            },
            enabled = !isPairing && serverText.isNotBlank() && codeText.length == 6,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (isPairing) {
                CircularProgressIndicator()
            } else {
                Text("Pair")
            }
        }
    }
}
