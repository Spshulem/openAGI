package sh.openagi.mobile.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.launch
import sh.openagi.mobile.BuildConfig
import sh.openagi.mobile.store.AlertPrefs
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.sync.SupervisorAlertService
import sh.openagi.mobile.sync.forgetPairing
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.ui.components.DestructiveTextButton
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
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
    onRestartSetup: () -> Unit,
    onUsePhone: (() -> Unit)? = null,
    onUseServer: (() -> Unit)? = null,
) {
    var isWorking by remember { mutableStateOf(false) }
    var connectionIssue by remember { mutableStateOf<String?>(null) }
    var showingFallback by remember { mutableStateOf(false) }
    var showingDiscovery by remember { mutableStateOf(false) }
    var discoveredAddress by remember { mutableStateOf(credentials.server) }
    if (showingDiscovery) androidx.compose.material3.AlertDialog(
        onDismissRequest = { showingDiscovery = false },
        title = { Text("Find servers") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Your saved pairing stays connected to ${credentials.server}. Searching does not switch servers or share credentials.")
                ServerDiscoverySection(credentials.server, credentials.server) { discoveredAddress = it }
                androidx.compose.foundation.text.selection.SelectionContainer { Text(discoveredAddress) }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = { showingDiscovery = false }) { Text("Done") } },
    )
    if (showingFallback) sh.openagi.mobile.fallback.FallbackChatScreen(context, localAgentMode = credentials.isEmbedded) { showingFallback = false }
    val scope = rememberCoroutineScope()
    val client = remember(credentials) { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val store = remember(credentials) { SnapshotStore(Credentials.workspaceDirectory(context, credentials)) }

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
    var liveAlerts by remember { mutableStateOf(AlertPrefs.liveAlertsEnabled(context)) }

    fun refreshDisplayedState() {
        connection = connectionState()
        statusLine = store.load()?.ageInMinutes()?.let(RelativeTime::updated) ?: "Not synced yet"
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(title = "Settings", connection = connection)
        if (credentials.isEmbedded && onUseServer != null) {
            androidx.compose.material3.TextButton(onClick = onUseServer) { Text("Use saved server / connect a server") }
        } else if (onUsePhone != null) {
            androidx.compose.material3.TextButton(onClick = onUsePhone) { Text("Use agent on this phone") }
        }

        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            RowGroup {
                SettingsRow(label = "Runs on", value = if (credentials.isEmbedded) "This phone" else credentials.server)
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
                            val outcome = RefreshCoordinator(
                                client,
                                store,
                                OutboundQueue(Credentials.workspaceDirectory(context, credentials)),
                                onSnapshotChanged = { runCatching { TodayWidget().updateAll(context) } },
                            ).refresh()
                            connectionIssue = when (outcome) {
                                is sh.openagi.mobile.sync.RefreshOutcome.MainUnavailable -> "This worker can't access main. Your phone pairing is saved. Reconnect the worker to main and refresh."
                                is sh.openagi.mobile.sync.RefreshOutcome.Offline -> "Can't reach your server. Check its network connection; your pairing is saved."
                                else -> null
                            }
                            refreshDisplayedState()
                        } finally {
                            isWorking = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )

            androidx.compose.material3.OutlinedButton(onClick = { showingFallback = true }, modifier = Modifier.fillMaxWidth()) {
                Text(if (credentials.isEmbedded) "Gemini Nano · local model setup" else "Chat without server · local or hosted model")
            }
            androidx.compose.material3.OutlinedButton(onClick = { showingDiscovery = true }, modifier = Modifier.fillMaxWidth()) {
                Text("Find servers / check network")
            }
            connectionIssue?.let { Text(it, style = OpenAGIType.caption) }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                androidx.compose.material3.OutlinedButton(onClick = onRestartSetup, modifier = Modifier.fillMaxWidth()) {
                    Text("Run setup again")
                }
                Text("Replay the welcome and setup screens. Your pairing, saved models and conversations are kept.", style = OpenAGIType.caption)
            }

            RowGroup {
                // Blocked notifications mean no pings whatever the pref says, so
                // the switch shows off and a tap goes to the system page.
                val permitted = SupervisorAlertService.notificationsPermitted(context)
                SwitchRow(
                    label = "Live supervisor alerts",
                    help = if (permitted) {
                        "Pings you when an agent needs you. Keeps a quiet notification while on."
                    } else {
                        "Notifications are blocked. Tap to allow them."
                    },
                    checked = liveAlerts && permitted,
                    onCheckedChange = { on ->
                        if (!permitted) {
                            liveAlerts = true
                            AlertPrefs.setLiveAlertsEnabled(context, true)
                            openNotificationSettings(context)
                            return@SwitchRow
                        }
                        liveAlerts = on
                        AlertPrefs.setLiveAlertsEnabled(context, on)
                        if (on) {
                            // Switching on cannot help while Android blocks the
                            // notifications themselves; the one place to fix
                            // that is the system page, so go there.
                            if (!SupervisorAlertService.notificationsPermitted(context)) openNotificationSettings(context)
                            SupervisorAlertService.startIfEnabled(context, paired = true)
                        } else {
                            SupervisorAlertService.stop(context)
                        }
                    },
                )
            }

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
                            try {
                                forgetPairing(context, credentials)
                                onRevoked()
                            } catch (error: Exception) {
                                if (error is kotlinx.coroutines.CancellationException) throw error
                                connectionIssue = "Couldn't forget this pairing securely. Please try again."
                            } finally {
                                isWorking = false
                            }
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

// The whole row is the toggle (and the one accessibility target); the
// Switch only draws the state.
@Composable
private fun SwitchRow(label: String, help: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
            Text(help, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(
            checked = checked,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(checkedTrackColor = LocalOpenAGIColors.current.live),
        )
    }
}

// Returning from it resumes MainActivity, which starts alerts if they were
// turned on there.
private fun openNotificationSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp)) {
        Text(label, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = OpenAGIType.dataMono, color = MaterialTheme.colorScheme.onSurface)
    }
}
