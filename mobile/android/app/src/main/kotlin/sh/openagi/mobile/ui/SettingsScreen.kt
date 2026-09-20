package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.sync.RefreshWorker
import sh.openagi.mobile.transport.DaemonClient
import java.io.File

// Shows what this phone is paired to and lets a person force a refresh or
// unpair entirely. Never renders the token: only the server and node id are
// shown, matching the rest of the app's rule that the token stays in
// EncryptedSharedPreferences and nowhere else, including the screen.
@Composable
fun SettingsScreen(
    context: Context,
    credentials: Credentials,
    onRevoked: () -> Unit,
) {
    var isWorking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Text("Server: ${credentials.server}")
        Text("Node ID: ${credentials.nodeId}")
        Button(
            onClick = {
                isWorking = true
                scope.launch {
                    try {
                        RefreshCoordinator(
                            client,
                            SnapshotStore(context.filesDir),
                            OutboundQueue(context.filesDir),
                        ).refresh()
                    } finally {
                        isWorking = false
                    }
                }
            },
            enabled = !isWorking,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Refresh now") }
        Button(
            onClick = {
                isWorking = true
                scope.launch {
                    // Best-effort: tell the daemon first so it can drop the node
                    // immediately, but a phone that can't reach the daemon must
                    // still be able to forget its own credential and stop
                    // working locally.
                    try {
                        client.revoke()
                    } catch (error: Exception) {
                        // Ignored: the local revoke below still proceeds.
                    }
                    Credentials.clear(context)
                    RefreshWorker.cancel(context)
                    File(context.filesDir, "snapshot.json").delete()
                    isWorking = false
                    onRevoked()
                }
            },
            enabled = !isWorking,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Revoke this phone") }
    }
}
