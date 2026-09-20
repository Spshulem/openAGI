package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.Snapshot
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshCoordinator
import sh.openagi.mobile.sync.RefreshOutcome
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.components.TaskRow
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.rememberReducedMotion
import sh.openagi.mobile.widget.TodayWidget

// The main screen once a phone is paired: today's tasks, tappable to
// complete, matching the widget exactly. DESIGN.md: offline is a normal
// state, not an error — this always renders the last snapshot and lets the
// connection line (in ScreenHeader) say whether it's current.
@Composable
fun TodayScreen(
    context: Context,
    credentials: Credentials,
    // Bumped by MainActivity.onResume() and by any live SSE event that could
    // affect today's list. A LaunchedEffect keyed on Unit alone fires only
    // once for this composable's lifetime, so without this key a
    // background/foreground cycle — or a task-updated event — would leave
    // the list stale even though a refresh was warranted.
    resumeSignal: Int = 0,
    // DESIGN.md's "Screens must not be mostly empty": "under the task list:
    // the day's shape in one sentence, then, when something is waiting, a
    // single row linking to Inbox." Defaulted so existing callers/tests that
    // don't care about navigation keep compiling.
    onOpenInbox: () -> Unit = {},
) {
    val store = remember { SnapshotStore(context.filesDir) }
    val queue = remember { OutboundQueue(context.filesDir) }
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val coordinator = remember {
        RefreshCoordinator(client, store, queue, onSnapshotChanged = { runCatching { TodayWidget().updateAll(context) } })
    }
    var snapshot by remember { mutableStateOf(store.load()) }
    var completingIds by remember { mutableStateOf(setOf<String>()) }
    val reducedMotion = rememberReducedMotion()
    val scope = rememberCoroutineScope()

    fun connectionState(current: Snapshot?): ConnectionState = when {
        current == null -> ConnectionState.NeverSynced(credentials.server)
        current.lastRefreshFailed -> ConnectionState.Failed(credentials.server, current.ageInMinutes())
        else -> ConnectionState.Synced(credentials.server, current.ageInMinutes())
    }

    LaunchedEffect(resumeSignal) {
        coordinator.refresh()
        snapshot = store.load()
    }

    fun completeTask(task: TaskItem) {
        completingIds = completingIds + task.id
        scope.launch {
            if (!reducedMotion) delay(180)
            // Optimistic: hide the row, queue the completion for the daemon,
            // then try to send it right away without waiting for the next
            // scheduled refresh.
            snapshot = store.applyOptimisticCompletion(task.id)
            queue.enqueue(PendingOp.completeTask(task.id))
            runCatching { TodayWidget().updateAll(context) }
            coordinator.drainQueue()
            snapshot = store.load()
            completingIds = completingIds - task.id
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(title = "Today", connection = connectionState(snapshot))

        val current = snapshot
        if (current == null) {
            EmptyState("Nothing left today.", "New tasks appear here when OpenAGI or you add them.")
            return@Column
        }

        val visible = current.visibleToday
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (current.summary.brief.headline.isNotBlank()) {
                Text(current.summary.brief.headline, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
            }

            if (visible.isEmpty()) {
                EmptyState("Nothing left today.", "New tasks appear here when OpenAGI or you add them.")
            } else {
                RowGroup(modifier = Modifier.animateContentSize(tween(if (reducedMotion) 0 else 260))) {
                    visible.forEachIndexed { index, task ->
                        TaskRow(
                            title = task.title,
                            subtitle = if (task.overdue) "Overdue" else null,
                            subtitleIsAlert = task.overdue,
                            isCompleting = task.id in completingIds,
                            reducedMotion = reducedMotion,
                            onComplete = { completeTask(task) },
                        )
                        if (index != visible.lastIndex) Hairline()
                    }
                }

                val counts = current.visibleCounts
                Text(
                    "${counts.today} left today, ${counts.thisWeek} this week",
                    style = OpenAGIType.secondary,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (counts.pendingActions > 0) {
                    WaitingOnYouRow(count = counts.pendingActions, onClick = onOpenInbox)
                }
            }
        }
    }
}

// DESIGN.md: "when something is waiting, a single row linking to Inbox
// ('2 waiting on you')." One row, not a card — the same RowGroup treatment
// every other row in this app gets, so it reads as part of the list rather
// than a banner bolted on top of it.
@Composable
private fun WaitingOnYouRow(count: Int, onClick: () -> Unit) {
    RowGroup {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 20.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("$count waiting on you", style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}
