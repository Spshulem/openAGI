package sh.openagi.mobile.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.openagi.mobile.protocol.CreateTaskRequest
import sh.openagi.mobile.protocol.Task
import sh.openagi.mobile.protocol.UpdateTaskRequest
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.ui.components.ConnectionState
import sh.openagi.mobile.ui.components.DestructiveTextButton
import sh.openagi.mobile.ui.components.EmptyState
import sh.openagi.mobile.ui.components.PrimaryButton
import sh.openagi.mobile.ui.components.RowGroup
import sh.openagi.mobile.ui.components.ScreenHeader
import sh.openagi.mobile.ui.components.TaskRow
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.ErrorCopy
import sh.openagi.mobile.util.rememberReducedMotion
import java.time.Instant
import java.time.ZoneOffset

// FEATURES.md's "Tasks": the full manager, not a filtered view. Sectioned by
// bucket, full create/edit/delete, a queue filter. This screen owns its own
// fetch — it does not read the /mobile/summary snapshot Today/the widget
// share, since it needs the full task list GET /tasks returns.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(context: Context, credentials: Credentials, resumeSignal: Int = 0) {
    val client = remember { DaemonClient(credentials.server, credentials.nodeId, credentials.token) }
    val scope = rememberCoroutineScope()
    val reducedMotion = rememberReducedMotion()

    var queue by remember { mutableStateOf("user") }
    var tasks by remember { mutableStateOf<List<Task>?>(null) }
    var error by remember { mutableStateOf<ErrorCopy.Message?>(null) }
    var collapsedBuckets by remember { mutableStateOf(setOf<String>()) }
    var completingIds by remember { mutableStateOf(setOf<String>()) }
    var editingTask by remember { mutableStateOf<Task?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var lastSyncedMinutesAgo by remember { mutableStateOf<Int?>(null) }

    suspend fun load() {
        try {
            tasks = client.tasks(queue = queue)
            error = null
            lastSyncedMinutesAgo = 0
        } catch (daemonError: DaemonException) {
            error = ErrorCopy.forDaemon(daemonError, credentials.server)
        }
    }

    LaunchedEffect(resumeSignal, queue) { load() }

    fun completeTask(task: Task) {
        completingIds = completingIds + task.id
        scope.launch {
            if (!reducedMotion) kotlinx.coroutines.delay(180)
            try {
                client.completeTask(task.id)
            } catch (error: Exception) {
                // Best-effort visual feedback either way; a real failure will
                // show up again on the next load() since the task stays open.
            }
            load()
            completingIds = completingIds - task.id
        }
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(onClick = { showCreate = true }, containerColor = MaterialTheme.colorScheme.primary) {
                Text("+", style = OpenAGIType.section, color = androidx.compose.ui.graphics.Color.White)
            }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            ScreenHeader(
                title = "Tasks",
                connection = lastSyncedMinutesAgo?.let { ConnectionState.Synced(credentials.server, it) }
                    ?: ConnectionState.NeverSynced(credentials.server),
            )

            Row(
                modifier = Modifier.padding(horizontal = 20.dp).padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(selected = queue == "user", onClick = { queue = "user" }, label = { Text("Yours") })
                FilterChip(selected = queue == "agent", onClick = { queue = "agent" }, label = { Text("OpenAGI's") })
            }

            val message = error
            val list = tasks
            when {
                message != null && list == null -> EmptyState(message.headline, message.detail)
                list == null -> EmptyState("Loading…")
                list.isEmpty() -> EmptyState("Nothing here yet.", "Add a task with the + button.")
                else -> {
                    val byBucket = list.groupBy { it.bucket }
                    Column(
                        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        BucketFormat.ORDER.forEach { bucket ->
                            val bucketTasks = byBucket[bucket] ?: return@forEach
                            val collapsed = bucket in collapsedBuckets
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().clickable {
                                        collapsedBuckets = if (collapsed) collapsedBuckets - bucket else collapsedBuckets + bucket
                                    },
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(BucketFormat.label(bucket), style = OpenAGIType.section, color = MaterialTheme.colorScheme.onBackground)
                                    Text(
                                        "${bucketTasks.size}",
                                        style = OpenAGIType.secondary,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                if (!collapsed) {
                                    RowGroup {
                                        bucketTasks.forEachIndexed { index, task ->
                                            TaskRow(
                                                title = task.title,
                                                subtitle = if (task.status == "completed" || task.status == "cancelled") {
                                                    BucketFormat.statusLabel(task.status)
                                                } else {
                                                    null
                                                },
                                                isCompleting = task.id in completingIds,
                                                reducedMotion = reducedMotion,
                                                onComplete = { completeTask(task) },
                                                modifier = Modifier.clickable { editingTask = task },
                                            )
                                            if (index != bucketTasks.lastIndex) Hairline()
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        TaskEditorDialog(
            initial = null,
            onDismiss = { showCreate = false },
            onSave = { title, bucket, priority, dueDate, _ ->
                scope.launch {
                    try {
                        client.createTask(CreateTaskRequest(title = title, bucket = bucket, priority = priority, dueDate = dueDate))
                        showCreate = false
                        load()
                    } catch (daemonError: DaemonException) {
                        error = ErrorCopy.forDaemon(daemonError, credentials.server)
                        showCreate = false
                    }
                }
            },
            onDelete = null,
        )
    }

    editingTask?.let { task ->
        TaskEditorDialog(
            initial = task,
            onDismiss = { editingTask = null },
            onSave = { title, bucket, priority, dueDate, status ->
                scope.launch {
                    try {
                        client.updateTask(
                            task.id,
                            UpdateTaskRequest(title = title, bucket = bucket, priority = priority, status = status, dueDate = dueDate),
                        )
                        editingTask = null
                        load()
                    } catch (daemonError: DaemonException) {
                        error = ErrorCopy.forDaemon(daemonError, credentials.server)
                        editingTask = null
                    }
                }
            },
            onDelete = {
                scope.launch {
                    try {
                        client.deleteTask(task.id)
                        editingTask = null
                        load()
                    } catch (daemonError: DaemonException) {
                        error = ErrorCopy.forDaemon(daemonError, credentials.server)
                        editingTask = null
                    }
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskEditorDialog(
    initial: Task?,
    onDismiss: () -> Unit,
    onSave: (title: String, bucket: String, priority: Int, dueDate: Instant?, status: String?) -> Unit,
    onDelete: (() -> Unit)?,
) {
    var title by remember { mutableStateOf(initial?.title ?: "") }
    var bucket by remember { mutableStateOf(initial?.bucket ?: "today") }
    var priority by remember { mutableStateOf((initial?.priority ?: 50).toFloat()) }
    var status by remember { mutableStateOf(initial?.status ?: "pending") }
    var dueDate by remember { mutableStateOf(initial?.dueDate) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "New task" else "Edit task", style = OpenAGIType.section) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    placeholder = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Bucket", style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BucketFormat.ORDER.filter { it != "done" }.forEach { option ->
                            FilterChip(selected = bucket == option, onClick = { bucket = option }, label = { Text(BucketFormat.label(option)) })
                        }
                    }
                }

                if (initial != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Status", style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            BucketFormat.STATUSES.forEach { option ->
                                FilterChip(selected = status == option, onClick = { status = option }, label = { Text(BucketFormat.statusLabel(option)) })
                            }
                        }
                    }
                }

                Column {
                    Text("Priority: ${priority.toInt()}", style = OpenAGIType.secondary, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Slider(value = priority, onValueChange = { priority = it }, valueRange = 0f..100f)
                }

                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    TextButton(onClick = { showDatePicker = true }) {
                        Text(dueDate?.let { "Due " + it.atZone(ZoneOffset.UTC).toLocalDate() } ?: "Set due date")
                    }
                    if (dueDate != null) {
                        TextButton(onClick = { dueDate = null }) { Text("Clear") }
                    }
                }

                if (onDelete != null) {
                    DestructiveTextButton(text = "Delete task", onClick = { showDeleteConfirm = true })
                }
            }
        },
        confirmButton = {
            PrimaryButton(
                text = if (initial == null) "Create" else "Save",
                enabled = title.isNotBlank(),
                onClick = { onSave(title, bucket, priority.toInt(), dueDate, if (initial != null) status else null) },
            )
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )

    if (showDatePicker) {
        val state = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { dueDate = Instant.ofEpochMilli(it) }
                    showDatePicker = false
                }) { Text("Set") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("Cancel") } },
        ) {
            androidx.compose.material3.DatePicker(state = state)
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("Delete this task?") },
            text = { Text("This can't be undone.") },
            confirmButton = {
                DestructiveTextButton(text = "Delete", onClick = { showDeleteConfirm = false; onDelete?.invoke() })
            },
            dismissButton = { TextButton(onClick = { showDeleteConfirm = false }) { Text("Cancel") } },
        )
    }
}
