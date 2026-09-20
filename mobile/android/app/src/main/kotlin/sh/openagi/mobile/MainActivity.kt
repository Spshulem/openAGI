package sh.openagi.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.PairingPayload
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.ui.PairingScreen
import sh.openagi.mobile.ui.SettingsScreen
import sh.openagi.mobile.ui.TodayScreen

class MainActivity : ComponentActivity() {
    // Plain mutableStateOf held on the Activity, not inside setContent's
    // composition: a deep-link tap while the app is already open arrives via
    // onNewIntent, not onCreate, and must still be able to update what
    // PairingScreen shows.
    private val credentialsState = mutableStateOf<Credentials?>(null)
    private val pendingPairingState = mutableStateOf<PairingPayload?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        credentialsState.value = Credentials.load(this)
        pendingPairingState.value = intent?.data?.let { PairingPayload.from(it) }

        setContent {
            var showSettings by remember { mutableStateOf(false) }
            val credentials = credentialsState.value
            val pendingPairing = pendingPairingState.value

            MaterialTheme {
                when {
                    credentials == null -> PairingScreen(
                        context = this,
                        prefill = pendingPairing,
                        onPaired = { credentialsState.value = Credentials.load(this) },
                    )
                    showSettings -> SettingsScreen(
                        context = this,
                        credentials = credentials,
                        onRevoked = {
                            credentialsState.value = null
                            showSettings = false
                        },
                    )
                    else -> TodayScreen(
                        context = this,
                        credentials = credentials,
                        onOpenSettings = { showSettings = true },
                    )
                }
            }
        }
    }

    // singleTask launch mode means a second tap on the openagi://pair link
    // while the app is already in the foreground arrives here, not onCreate.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingPairingState.value = intent.data?.let { PairingPayload.from(it) }
    }

    override fun onResume() {
        super.onResume()
        val credentials = Credentials.load(this) ?: return
        val client = DaemonClient(credentials.server, credentials.nodeId, credentials.token)
        val coordinator = RefreshCoordinator(client, SnapshotStore(filesDir), OutboundQueue(filesDir))
        lifecycleScope.launch { coordinator.refresh() }
    }
}
