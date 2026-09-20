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
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.DestructiveTextButton
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy
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

    var actions by remember { mutableStateOf<List<PendingAction>?>(null) }
    var clarifications by remember { mutableStateOf<List<Clarification>?>(null) }
    var error by remember { mutableStateOf<ErrorCopy.Message?>(null) }
    var openAction by remember { mutableStateOf<PendingAction?>(null) }
    var openClarification by remember { mutableStateOf<Clarification?>(null) }
    var lastSyncedAgo by remember { mutableStateOf<Int?>(null) }

    suspend fun load() {
        try {
            actions = client.pendingActions()
            clarifications = client.clarifications()
            error = null
            lastSyncedAgo = 0
            onBadgeCountChanged((actions?.size ?: 0) + (clarifications?.size ?: 0))
        } catch (daemonError: DaemonException) {
            error = ErrorCopy.forDaemon(daemonError, credentials.server)
        }
    }

    LaunchedEffect(resumeSignal) { load() }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "Inbox",
            connection = lastSyncedAgo?.let { ConnectionState.Synced(credentials.server, it) }
                ?: ConnectionState.NeverSynced(credentials.server),
        )

        val pendingActions = actions
        val pendingClarifications = clarifications
        if (pendingActions == null && pendingClarifications == null) {
            error?.let { EmptyState(it.headline, it.detail) } ?: EmptyState("Loading…")
        } else if (pendingActions.orEmpty().isEmpty() && pendingClarifications.orEmpty().isEmpty()) {
            EmptyState("Nothing waiting on you.", "Approvals and questions from OpenAGI show up here.")
        } else {
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                if (!pendingActions.isNullOrEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Approvals", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                        RowGroup {
                            pendingActions.forEachIndexed { index, action ->
                                InboxRow(
                                    title = action.summary.ifBlank { action.toolName },
                                    subtitle = action.createdAt?.let { "Raised " + RelativeTime.short(minutesAgo(it)) + " ago" },
                                    onClick = { openAction = action },
                                )
                                if (index != pendingActions.lastIndex) Hairline()
                            }
                        }
                    }
                }

                if (!pendingClarifications.isNullOrEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Clarifications", style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                        RowGroup {
                            pendingClarifications.forEachIndexed { index, clarification ->
                                InboxRow(
                                    title = clarification.question,
                                    subtitle = clarification.createdAt?.let { "Asked " + RelativeTime.short(minutesAgo(it)) + " ago" },
                                    onClick = { openClarification = clarification },
                                )
                                if (index != pendingClarifications.lastIndex) Hairline()
                            }
                        }
                    }
                }
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
                    load()
                }
            },
            onDeny = { reason ->
                scope.launch {
                    try {
                        client.denyAction(action.id, reason.ifBlank { null })
                    } catch (error: Exception) {
                    }
                    openAction = null
                    load()
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
                    load()
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
