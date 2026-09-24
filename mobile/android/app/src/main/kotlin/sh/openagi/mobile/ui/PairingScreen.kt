package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.style.TextAlign
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
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy

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
    // Keyed on prefill like the fields: a fresh link is a fresh attempt, and
    // the last code's "That code didn't work" must not sit under a new one.
    var error by remember(prefill) { mutableStateOf<ErrorCopy.Message?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text("Pair with OpenAGI", style = OpenAGIType.screenTitle, color = MaterialTheme.colorScheme.onBackground)

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Daemon address", style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                value = serverText,
                onValueChange = { serverText = it },
                placeholder = { Text("http://mac.tail1234.ts.net:43210") },
                singleLine = true,
                textStyle = OpenAGIType.dataMono,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("6-digit code", style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // DESIGN.md: nothing is centred except the empty state and this
            // field. Code entry gets its own reserved type role (28 medium
            // mono, tracked +2) — never reused for anything else.
            OutlinedTextField(
                value = codeText,
                onValueChange = { if (it.length <= 6 && it.all(Char::isDigit)) codeText = it },
                singleLine = true,
                textStyle = OpenAGIType.codeEntry.copy(textAlign = TextAlign.Center),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        error?.let { message ->
            Column {
                Text(message.headline, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
                Text(message.detail, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        PrimaryButton(
            text = "Pair",
            loading = isPairing,
            enabled = !isPairing && serverText.isNotBlank() && codeText.length == 6,
            onClick = {
                error = null
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
                        if (!Credentials.save(context, credentials)) {
                            error = ErrorCopy.Message(
                                "Couldn't save the credential on this device.",
                                "Try pairing again — if this keeps happening, restart the app.",
                            )
                            return@launch
                        }
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
                    } catch (daemonError: DaemonException) {
                        error = ErrorCopy.forPairing(daemonError, serverText)
                    } catch (unexpected: Exception) {
                        error = ErrorCopy.Message("Pairing failed.", "Try again, or run openagi pair-phone for a new code.")
                    } finally {
                        isPairing = false
                    }
                }
            },
        )
    }
}
