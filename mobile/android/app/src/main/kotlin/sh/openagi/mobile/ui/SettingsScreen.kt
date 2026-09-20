package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.launch
import sh.openagi.mobile.BuildConfig
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.sync.RefreshWorker
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.ui.components.DestructiveTextButton
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.RelativeTime
import sh.openagi.mobile.widget.TodayWidget

// The connection (host, node id, last sync), a refresh, and revoke.
// Host and node id in mono per DESIGN.md; the token itself is never shown —
// it lives in EncryptedSharedPreferences and nowhere else, including here.
@Composable
fun SettingsScreen(
    context: Context,
    credentials: Credentials,
    onRevoked: () -> Unit,
) {
    var isWorking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val store = remember { SnapshotStore(context.filesDir) }

    fun connectionState(): ConnectionState {
        val snapshot = store.load() ?: return ConnectionState.NeverSynced(credentials.server)
        return if (snapshot.lastRefreshFailed) {
            ConnectionState.Failed(credentials.server, snapshot.ageInMinutes())
        } else {
            ConnectionState.Synced(credentials.server, snapshot.ageInMinutes())
        }
    }

    var connection by remember { mutableStateOf(connectionState()) }
    var statusLine by remember { mutableStateOf(store.load()?.ageInMinutes()?.let(RelativeTime::updated) ?: "Not synced yet") }

    fun refreshDisplayedState() {
        connection = connectionState()
        statusLine = store.load()?.ageInMinutes()?.let(RelativeTime::updated) ?: "Not synced yet"
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(title = "Settings", connection = connection)

        Column(
            modifier = Modifier.padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            RowGroup {
                SettingsRow(label = "Server", value = credentials.server)
                Hairline()
                SettingsRow(label = "Node ID", value = credentials.nodeId)
                Hairline()
                SettingsRow(label = "Last synced", value = statusLine)
            }

            PrimaryButton(
                text = "Refresh now",
                loading = isWorking,
                enabled = !isWorking,
                onClick = {
                    isWorking = true
                    scope.launch {
                        try {
                            RefreshCoordinator(
                                client,
                                store,
                                OutboundQueue(context.filesDir),
                                onSnapshotChanged = { runCatching { TodayWidget().updateAll(context) } },
                            ).refresh()
                            refreshDisplayedState()
                        } finally {
                            isWorking = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Revoking clears this phone's credential, its cached tasks and its outbox, and tells OpenAGI to forget it.",
                    style = OpenAGIType.secondary,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                DestructiveTextButton(
                    text = "Revoke this phone",
                    enabled = !isWorking,
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
                            // Both go through the stores rather than deleting the file
                            // directly, so the delete holds the same lock every writer
                            // holds. Clearing the outbox matters as much as the
                            // snapshot: a queued completion left behind would replay
                            // against whatever account pairs next.
                            store.delete()
                            OutboundQueue(context.filesDir).clear()
                            isWorking = false
                            onRevoked()
                        }
                    },
                )
            }

            Text(
                "OpenAGI for Android — ${BuildConfig.VERSION_NAME}",
                style = OpenAGIType.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp)) {
        Text(label, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = OpenAGIType.dataMono, color = MaterialTheme.colorScheme.onSurface)
    }
}
