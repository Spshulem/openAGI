package sh.openagi.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sh.openagi.mobile.protocol.LifelogMoment
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// Read-only view of what the paired G2s captured with consent, by day, with
// search (GET /lifelog/moments, PROTOCOL.md §3.2). Nothing here changes the
// lifelog; editing and deleting stay on the owner's dashboard.
@Composable
fun LifelogScreen(credentials: Credentials, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val zone = remember { ZoneId.systemDefault() }
    var query by rememberSaveable { mutableStateOf("") }
    var dayText by rememberSaveable { mutableStateOf<String?>(null) }
    val day = dayText?.let { LocalDate.parse(it) }
    var moments by remember { mutableStateOf<List<LifelogMoment>?>(null) }
    var error by remember { mutableStateOf<ErrorCopy.Message?>(null) }
    var loadedAt by remember { mutableStateOf<Instant?>(null) }
    var expanded by remember { mutableStateOf(setOf<String>()) }

    LaunchedEffect(query, dayText) {
        // Typing waits for a pause; a day change loads at once.
        if (query.isNotEmpty()) delay(300)
        try {
            moments = client.lifelogMoments(date = day, query = query, limit = 100)
            error = null
            loadedAt = Instant.now()
        } catch (failure: DaemonException) {
            error = ErrorCopy.forDaemon(failure, credentials.server)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TextButton(onClick = onBack, modifier = Modifier.padding(start = 8.dp, top = 4.dp)) {
            Text("Back", style = OpenAGIType.body, color = LocalOpenAGIColors.current.live)
        }
        val age = loadedAt?.let { ((Instant.now().epochSecond - it.epochSecond) / 60).toInt() }
        ScreenHeader(
            title = "Lifelog",
            connection = when {
                error != null -> ConnectionState.Failed(credentials.server, age)
                age != null -> ConnectionState.Synced(credentials.server, age)
                else -> ConnectionState.NeverSynced(credentials.server)
            },
        )
        Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it.take(200) },
                placeholder = { Text("Search words, people, topics") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            DayPicker(
                day = day,
                today = LocalDate.now(zone),
                onChange = { dayText = it?.toString() },
            )
        }

        val shown = moments
        val failure = error
        when {
            shown == null && failure != null -> EmptyState(failure.headline, failure.detail)
            shown == null -> EmptyState("Loading the lifelog…")
            shown.isEmpty() -> EmptyState(
                if (query.isBlank() && day == null) "No moments yet." else "Nothing matches.",
                if (query.isBlank() && day == null) "Conversations a paired G2 captures with consent appear here." else "Try other words or another day.",
            )
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LifelogFormat.byDay(shown, zone).forEach { (date, group) ->
                    item(key = "day-$date") {
                        Text(
                            LifelogFormat.dayLabel(date, LocalDate.now(zone)),
                            style = OpenAGIType.section,
                            color = MaterialTheme.colorScheme.onBackground,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }
                    item(key = "moments-$date") {
                        RowGroup {
                            group.forEachIndexed { index, moment ->
                                MomentRow(
                                    moment = moment,
                                    zone = zone,
                                    open = moment.id in expanded,
                                    onToggle = { expanded = if (moment.id in expanded) expanded - moment.id else expanded + moment.id },
                                )
                                if (index != group.lastIndex) Hairline()
                            }
                        }
                    }
                }
                item(key = "end") { Text(" ", modifier = Modifier.padding(bottom = 16.dp)) }
            }
        }
    }
}

@Composable
private fun DayPicker(day: LocalDate?, today: LocalDate, onChange: (LocalDate?) -> Unit) {
    val live = LocalOpenAGIColors.current.live
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { onChange((day ?: today.plusDays(1)).minusDays(1)) }) {
            Text("‹", style = OpenAGIType.body, color = live)
        }
        Text(
            day?.let { LifelogFormat.dayLabel(it, today) } ?: "Any day",
            style = OpenAGIType.secondary,
            color = MaterialTheme.colorScheme.onSurface,
        )
        TextButton(onClick = { if (day != null && day < today) onChange(day.plusDays(1)) }, enabled = day != null && day < today) {
            Text("›", style = OpenAGIType.body)
        }
        if (day != null) {
            TextButton(onClick = { onChange(null) }) {
                Text("Any day", style = OpenAGIType.secondary, color = live)
            }
        }
    }
}

@Composable
private fun MomentRow(moment: LifelogMoment, zone: ZoneId, open: Boolean, onToggle: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(LifelogFormat.title(moment), style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
        Text("${LifelogFormat.timeRange(moment, zone)} · ${moment.deviceName}", style = OpenAGIType.caption, color = muted)
        moment.summary?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurface)
        }
        if (open) {
            Text(moment.transcript, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = 4.dp))
        } else if (moment.transcript.isNotBlank()) {
            Text("Show transcript", style = OpenAGIType.caption, color = LocalOpenAGIColors.current.live)
        }
    }
}
