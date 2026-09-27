package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import sh.openagi.mobile.protocol.Clarification
import sh.openagi.mobile.protocol.ClarificationAnswer
import sh.openagi.mobile.protocol.PendingAction
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.sync.fetchInboxBadgeCount
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.DestructiveTextButton
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.RelativeTime
import java.time.Instant

// A separate, once-built Json instance for the arguments pretty-print below
// — ProtocolJson's own instance (ignoreUnknownKeys, no pretty print) is for
// wire decoding, not for a human-readable dump in a dialog.
private val PrettyJson = Json { prettyPrint = true }

// FEATURES.md's "Inbox": approvals and clarifications, the two things that
// need a person, together. onBadgeCountChanged lets an approve/deny/answer
// update the nav bar's badge immediately rather than waiting for the next
// SSE-driven refresh.
@Composable
fun InboxScreen(
    context: Context,
    credentials: Credentials,
    resumeSignal: Int = 0,
    onBadgeCountChanged: (Int) -> Unit = {},
) {
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val scope = rememberCoroutineScope()

    var load by remember { mutableStateOf<InboxLoadResult?>(null) }
    var openAction by remember { mutableStateOf<PendingAction?>(null) }
    var openClarification by remember { mutableStateOf<Clarification?>(null) }
    var lastSyncedAgo by remember { mutableStateOf<Int?>(null) }
    var lastLoadFullyFailed by remember { mutableStateOf(false) }

    suspend fun refresh() {
        val result = loadInbox(client, credentials.server)
        load = result
        val anySucceeded = result.actions.error == null || result.clarifications.error == null
        lastLoadFullyFailed = !anySucceeded
        if (anySucceeded) lastSyncedAgo = 0
        onBadgeCountChanged((result.actions.items?.size ?: 0) + (result.clarifications.items?.size ?: 0))
    }

    LaunchedEffect(resumeSignal) { refresh() }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "Inbox",
            // A failed refresh must win over a stale "last good" timestamp —
            // otherwise a phone that synced once and then lost the daemon
            // keeps reading "live, just now" forever, which is exactly the
            // always-visible honesty DESIGN.md's connection line exists for.
            connection = when {
                lastLoadFullyFailed -> ConnectionState.Failed(credentials.server, lastSyncedAgo)
                lastSyncedAgo != null -> ConnectionState.Synced(credentials.server, lastSyncedAgo!!)
                else -> ConnectionState.NeverSynced(credentials.server)
            },
        )

        val current = load
        if (current == null) {
            EmptyState("Loading…")
        } else {
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                InboxSection(
                    title = "Approvals",
                    state = current.actions,
                    emptyLabel = "No approvals waiting.",
                    rowFor = { action ->
                        InboxRowData(
                            title = action.summary.ifBlank { action.toolName },
                            subtitle = action.createdAt?.let { "Raised " + RelativeTime.short(minutesAgo(it)) + " ago" },
                            onClick = { openAction = action },
                        )
                    },
                )

                InboxSection(
                    title = "Clarifications",
                    state = current.clarifications,
                    emptyLabel = "No questions waiting.",
                    rowFor = { clarification ->
                        InboxRowData(
                            title = clarification.question,
                            subtitle = clarification.createdAt?.let { "Asked " + RelativeTime.short(minutesAgo(it)) + " ago" },
                            onClick = { openClarification = clarification },
                        )
                    },
                )
            }
        }
    }

    openAction?.let { action ->
        ApprovalDetailDialog(
            action = action,
            onDismiss = { openAction = null },
            onApprove = {
                scope.launch {
                    try {
                        client.approveAction(action.id)
                    } catch (error: Exception) {
                        // The daemon's own approve response already carries the
                        // failure reason when the tool itself failed; a
                        // transport/auth failure here just means the list will
                        // still show it as pending on the next load.
                    }
                    openAction = null
                    refresh()
                }
            },
            onDeny = { reason ->
                scope.launch {
                    try {
                        client.denyAction(action.id, reason.ifBlank { null })
                    } catch (error: Exception) {
                    }
                    openAction = null
                    refresh()
                }
            },
        )
    }

    openClarification?.let { clarification ->
        ClarificationDetailDialog(
            clarification = clarification,
            onDismiss = { openClarification = null },
            onAnswer = { answer ->
                scope.launch {
                    try {
                        client.answerClarification(clarification.id, answer)
                    } catch (error: Exception) {
                    }
                    openClarification = null
                    refresh()
                }
            },
        )
    }
}

private fun minutesAgo(instant: Instant): Int =
    ((Instant.now().epochSecond - instant.epochSecond) / 60).toInt().coerceAtLeast(0)

@Composable
private fun InboxRow(title: String, subtitle: String?, onClick: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp),
    ) {
        Text(title, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
        if (subtitle != null) {
            Text(subtitle, style = OpenAGIType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private data class InboxRowData(val title: String, val subtitle: String?, val onClick: () -> Unit)

// DESIGN.md: "approvals and clarifications are two sections of one list. If
// one of the two fails to load, the other still renders, and the failure is
// a single inline row in that section, not an error that replaces the
// screen." The section header is always present — a badge promising an item
// above a section that silently vanished is worse than either alone.
@Composable
private fun <T> InboxSection(
    title: String,
    state: InboxSectionState<T>,
    emptyLabel: String,
    rowFor: (T) -> InboxRowData,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
        RowGroup {
            val error = state.error
            val items = state.items
            when {
                error != null -> InboxInlineMessage(error.headline, isAlert = true)
                items == null -> InboxInlineMessage("Loading…", isAlert = false)
                items.isEmpty() -> InboxInlineMessage(emptyLabel, isAlert = false)
                else -> items.map(rowFor).forEachIndexed { index, row ->
                    InboxRow(title = row.title, subtitle = row.subtitle, onClick = row.onClick)
                    if (index != items.lastIndex) Hairline()
                }
            }
        }
    }
}

@Composable
private fun InboxInlineMessage(text: String, isAlert: Boolean) {
    val colors = LocalOpenAGIColors.current
    Text(
        text,
        style = OpenAGIType.caption,
        color = if (isAlert) colors.alert else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
    )
}

@Composable
private fun ApprovalDetailDialog(action: PendingAction, onDismiss: () -> Unit, onApprove: () -> Unit, onDeny: (String) -> Unit) {
    var denying by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    val colors = LocalOpenAGIColors.current

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(action.toolName, style = OpenAGIType.section) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (action.summary.isNotBlank()) {
                    Text(action.summary, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
                }
                action.reason?.let { Text(it, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                action.args?.let { args ->
                    Text("Arguments", style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        runCatching { PrettyJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), args) }
                            .getOrDefault(args.toString()),
                        style = OpenAGIType.dataMono,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
                if (denying) {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        placeholder = { Text("Reason (optional)") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            if (denying) {
                PrimaryButton(text = "Deny", onClick = { onDeny(reason) })
            } else {
                PrimaryButton(text = "Approve", onClick = onApprove)
            }
        },
        dismissButton = {
            if (denying) {
                TextButton(onClick = { denying = false }) { Text("Back") }
            } else {
                DestructiveTextButton(text = "Deny", onClick = { denying = true })
            }
        },
    )
}

@Composable
private fun ClarificationDetailDialog(clarification: Clarification, onDismiss: () -> Unit, onAnswer: (String) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(clarification.question, style = OpenAGIType.section) },
        text = {
            clarification.context?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            PrimaryButton(text = "Yes, done", onClick = { onAnswer(ClarificationAnswer.YES) })
        },
        dismissButton = {
            Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                TextButton(onClick = { onAnswer(ClarificationAnswer.IN_PROGRESS) }) { Text("Still working") }
                TextButton(onClick = { onAnswer(ClarificationAnswer.NO) }) { Text("No") }
                TextButton(onClick = { onAnswer(ClarificationAnswer.DROPPED) }) { Text("Drop it") }
            }
        },
    )
}
