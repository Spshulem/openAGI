package sh.openagi.mobile.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import sh.openagi.mobile.MainActivity
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.util.RelativeTime
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.RefreshWorker

// The Glance twin of TodayScreen: the worker owns refresh (RefreshWorker,
// DrainWorker), this owns rendering, and it never performs network I/O
// itself. Everything it draws comes from what SnapshotStore last had written
// to it and whether a credential currently exists -- both cheap, synchronous,
// on-device reads.
class TodayWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // SnapshotStore.load() already turns a missing or corrupt file into
        // null rather than throwing, and Credentials.load() returns null
        // rather than a token when nothing is stored, so there is no snapshot
        // shape here that can crash the widget host.
        val snapshot = SnapshotStore(context.filesDir).load()
        val paired = Credentials.load(context) != null
        val state = WidgetState.from(snapshot, paired)

        provideContent {
            GlanceTheme {
                WidgetContent(state)
            }
        }
    }
}

@Composable
private fun WidgetContent(state: WidgetState) {
    Column(modifier = GlanceModifier.fillMaxSize().padding(12.dp)) {
        when (state) {
            is WidgetState.Unpaired -> UnpairedContent()
            is WidgetState.Empty -> EmptyContent(state)
            is WidgetState.Tasks -> TasksContent(state)
            is WidgetState.Stale -> StaleContent(state)
            is WidgetState.Unreachable -> UnreachableContent(state)
        }
    }
}

@Composable
private fun UnpairedContent() {
    Text(
        text = "Pair this phone",
        style = TextStyle(color = GlanceTheme.colors.onBackground),
        modifier = GlanceModifier.fillMaxSize().clickable(actionStartActivity<MainActivity>()),
    )
}

@Composable
private fun EmptyContent(state: WidgetState.Empty) {
    // WidgetState.Empty carries only a headline: either nothing has ever been
    // fetched (no age exists to report) or every visible task is done. Both
    // read the same on screen.
    Text(text = state.headline, style = TextStyle(color = GlanceTheme.colors.onBackground))
}

@Composable
private fun TasksContent(state: WidgetState.Tasks) {
    // Home-screen real estate is small; three rows is a widget, not the app.
    state.items.take(3).forEach { item -> TaskRow(item) }
    Text(
        text = countsLine(state.counts.today, state.counts.overdue),
        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant),
    )
    Text(text = ageLine(state.ageMinutes), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
}

@Composable
private fun TaskRow(item: TaskItem) {
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The check button: tapping it writes an optimistic completion plus a
        // queued op through CompleteTaskAction. The widget never touches the
        // store or the queue directly for the write path either.
        Text(
            text = "✓",
            style = TextStyle(color = GlanceTheme.colors.primary, fontWeight = FontWeight.Bold),
            modifier = GlanceModifier
                .padding(end = 12.dp)
                .clickable(
                    actionRunCallback<CompleteTaskAction>(
                        actionParametersOf(CompleteTaskAction.taskIdKey to item.id),
                    ),
                ),
        )
        Text(text = item.title, style = TextStyle(color = GlanceTheme.colors.onBackground))
    }
}

@Composable
private fun StaleContent(state: WidgetState.Stale) {
    Text(
        text = RelativeTime.lastSynced(state.ageMinutes) + " — tap to refresh",
        style = TextStyle(color = GlanceTheme.colors.error, fontWeight = FontWeight.Bold),
        modifier = GlanceModifier.fillMaxSize().clickable(actionRunCallback<RequestRefreshAction>()),
    )
}

// The last refresh attempt failed, but there is still a last-known snapshot
// worth showing — DESIGN.md: every screen (and by extension the widget)
// renders from the last snapshot when the daemon is unreachable. State the
// fact plainly rather than either hiding the tasks or pretending they're
// current; do not say "offline" when a failed refresh is all that's known.
@Composable
private fun UnreachableContent(state: WidgetState.Unreachable) {
    Text(
        text = "Can't reach OpenAGI",
        style = TextStyle(color = GlanceTheme.colors.error, fontWeight = FontWeight.Bold),
    )
    state.items.take(3).forEach { item -> TaskRow(item) }
    Text(
        text = countsLine(state.counts.today, state.counts.overdue),
        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant),
    )
}

private fun countsLine(today: Int, overdue: Int): String =
    if (overdue > 0) "$today today, $overdue overdue" else "$today today"

private fun ageLine(ageMinutes: Int): String =
    if (ageMinutes <= 0) "Updated just now" else "Updated ${ageMinutes}m ago"

// Tapping the stale banner cannot fetch from the widget's own coroutine --
// the widget performs no network I/O -- so it only enqueues the same worker
// RefreshWorker's own schedule uses. The fetch, and the repaint once it
// lands, happen there.
class RequestRefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<RefreshWorker>().build())
    }
}
