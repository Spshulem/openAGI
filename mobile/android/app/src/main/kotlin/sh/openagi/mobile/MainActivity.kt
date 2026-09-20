package sh.openagi.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import sh.openagi.mobile.protocol.PairingPayload
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.sync.fetchInboxBadgeCount
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.EventStream
import sh.openagi.mobile.ui.ChatScreen
import sh.openagi.mobile.ui.InboxScreen
import sh.openagi.mobile.ui.PairingScreen
import sh.openagi.mobile.ui.SettingsScreen
import sh.openagi.mobile.ui.TasksScreen
import sh.openagi.mobile.ui.TodayScreen
import sh.openagi.mobile.ui.components.AppNavigationBar
import sh.openagi.mobile.ui.components.AppTab
import sh.openagi.mobile.ui.theme.OpenAGITheme

// Events on GET /events that mean "a surface other than Chat might now be
// stale" — PROTOCOL.md §7's table of what a mobile client reacts to.
private val REFRESH_TRIGGERING_EVENTS = setOf(
    "task-updated",
    "task-auto-changed",
    "pending-action",
    "pending-action-resolved",
    "clarification-created",
)
private val INBOX_AFFECTING_EVENTS = setOf("pending-action", "pending-action-resolved", "clarification-created")

class MainActivity : ComponentActivity() {
    // Plain mutableStateOf held on the Activity, not inside setContent's
    // composition: a deep-link tap while the app is already open arrives via
    // onNewIntent, not onCreate, and must still be able to update what
    // PairingScreen shows.
    private val credentialsState = mutableStateOf<Credentials?>(null)
    private val pendingPairingState = mutableStateOf<PairingPayload?>(null)

    // Bumped in onResume AND on any live SSE event that could affect what a
    // screen is showing — a LaunchedEffect keyed on Unit alone would only
    // ever refresh once for a composable's lifetime.
    private val resumeSignalState = mutableIntStateOf(0)
    private val inboxBadgeState = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        credentialsState.value = Credentials.load(this)
        pendingPairingState.value = intent?.data?.let { PairingPayload.from(it) }

        setContent {
            var selectedTab by remember { mutableStateOf(AppTab.TODAY) }
            val credentials = credentialsState.value
            val pendingPairing = pendingPairingState.value
            val resumeSignal = resumeSignalState.intValue
            val inboxBadge = inboxBadgeState.intValue

            OpenAGITheme {
                if (credentials == null) {
                    PairingScreen(
                        context = this,
                        prefill = pendingPairing,
                        onPaired = { credentialsState.value = Credentials.load(this) },
                    )
                } else {
                    // One background SSE connection for the life of this
                    // pairing, reconnected with backoff by EventStream. This
                    // is what makes Inbox's badge and the other tabs feel
                    // live rather than polled (FEATURES.md's Chat section).
                    LaunchedEffect(credentials) {
                        val client = DaemonClient(credentials.server, credentials.nodeId, credentials.token)
                        inboxBadgeState.intValue = runCatching { fetchInboxBadgeCount(client) }.getOrDefault(inboxBadgeState.intValue)
                        EventStream(client).connect().collect { frame ->
                            if (frame.event in REFRESH_TRIGGERING_EVENTS) {
                                resumeSignalState.intValue += 1
                            }
                            if (frame.event in INBOX_AFFECTING_EVENTS) {
                                inboxBadgeState.intValue = runCatching { fetchInboxBadgeCount(client) }.getOrDefault(inboxBadgeState.intValue)
                            }
                        }
                    }

                    Scaffold(
                        bottomBar = {
                            AppNavigationBar(selected = selectedTab, inboxBadgeCount = inboxBadge, onSelect = { selectedTab = it })
                        },
                    ) { padding ->
                        Box(modifier = Modifier.padding(padding)) {
                            when (selectedTab) {
                                AppTab.TODAY -> TodayScreen(context = this@MainActivity, credentials = credentials, resumeSignal = resumeSignal)
                                AppTab.TASKS -> TasksScreen(context = this@MainActivity, credentials = credentials, resumeSignal = resumeSignal)
                                AppTab.INBOX -> InboxScreen(
                                    context = this@MainActivity,
                                    credentials = credentials,
                                    resumeSignal = resumeSignal,
                                    onBadgeCountChanged = { inboxBadgeState.intValue = it },
                                )
                                AppTab.CHAT -> ChatScreen(context = this@MainActivity, credentials = credentials)
                                AppTab.SETTINGS -> SettingsScreen(
                                    context = this@MainActivity,
                                    credentials = credentials,
                                    onRevoked = { credentialsState.value = null },
                                )
                            }
                        }
                    }
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
        resumeSignalState.intValue += 1
    }
}
