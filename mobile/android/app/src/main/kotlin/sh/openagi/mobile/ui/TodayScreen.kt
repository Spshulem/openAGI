package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.sync.RefreshOutcome
import sh.openagi.mobile.transport.DaemonClient

// The main screen once a phone is paired: today's tasks, tappable to
// complete, with a line showing how stale the data is. Task 15 adds a widget
// repaint alongside the drainQueue() call below; the widget does not exist
// yet in this task.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayScreen(
    context: Context,
    credentials: Credentials,
    onOpenSettings: () -> Unit,
) {
    val store = remember { SnapshotStore(context.filesDir) }
    val queue = remember { OutboundQueue(context.filesDir) }
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val coordinator = remember { RefreshCoordinator(client, store, queue) }
    var snapshot by remember { mutableStateOf(store.load()) }
    var statusLine by remember { mutableStateOf("Not synced yet") }
    val scope = rememberCoroutineScope()

    suspend fun refreshAndUpdateStatus() {
        val outcome = coordinator.refresh()
        snapshot = store.load()
        statusLine = when (outcome) {
            is RefreshOutcome.Unauthorized -> "Needs re-pairing — revoke and pair again in Settings"
            is RefreshOutcome.Offline -> "Can't reach OpenAGI"
            else -> {
                val age = snapshot?.ageInMinutes()
                when {
                    age == null -> "Not synced yet"
                    age == 0 -> "Updated just now"
                    else -> "Updated ${age}m ago"
                }
            }
        }
    }

    LaunchedEffect(Unit) { refreshAndUpdateStatus() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Today") },
                actions = { TextButton(onClick = onOpenSettings) { Text("Settings") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Text(
                statusLine,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            val visible = snapshot?.visibleToday ?: emptyList()
            if (visible.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Nothing due today.")
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(visible, key = { it.id }) { task ->
                        TaskRow(
                            task = task,
                            onComplete = {
                                scope.launch {
                                    // Optimistic: hide the row immediately, queue
                                    // the completion for the daemon, then try to
                                    // send it right away without waiting for the
                                    // next scheduled refresh.
                                    snapshot = store.applyOptimisticCompletion(task.id)
                                    queue.enqueue(PendingOp.completeTask(task.id))
                                    coordinator.drainQueue()
                                    snapshot = store.load()
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: TaskItem, onComplete: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text(task.title)
            if (task.overdue) {
                Text(
                    "Overdue",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Button(onClick = onComplete) { Text("Done") }
    }
}
