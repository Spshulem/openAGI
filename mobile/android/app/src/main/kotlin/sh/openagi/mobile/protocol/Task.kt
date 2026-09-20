package sh.openagi.mobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Instant

// The full task shape, as returned by GET /tasks, GET /tasks/:id, POST
// /tasks, PATCH /tasks/:id and POST /tasks/:id/complete — pinned by
// mobile/fixtures/tasks-list.json. TaskItem (Models.kt) is the trimmed
// summary shape /mobile/summary uses instead; the two are deliberately
// separate types rather than one with optional fields, since a widget must
// never accidentally depend on a field only the full manager screen has.
@Serializable
data class Task(
    val id: String,
    val queue: String = "user",
    val title: String,
    val description: String = "",
    val bucket: String,
    val priority: Int = 50,
    val category: String? = null,
    val tags: List<String> = emptyList(),
    val source: String? = null,
    val sourceId: String? = null,
    val sourceUrl: String? = null,
    val sourceMeta: JsonElement? = null,
    val status: String,
    @Serializable(with = InstantSerializer::class) val dueDate: Instant? = null,
    @Serializable(with = InstantSerializer::class) val scheduledFor: Instant? = null,
    val parentGoalId: String? = null,
    val dependsOn: List<String> = emptyList(),
    @Serializable(with = InstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = InstantSerializer::class) val updatedAt: Instant? = null,
    @Serializable(with = InstantSerializer::class) val completedAt: Instant? = null,
    val completedVia: String? = null,
)

// GET /tasks's envelope is `{"tasks": [...], "stats": {...}}`. `stats` is
// left undeclared here (ignoreUnknownKeys drops it silently on decode) since
// nothing on the phone currently reads it; FEATURES.md's Tasks screen only
// needs the list, sectioned client-side by `bucket`.
@Serializable
data class TasksListResponse(val tasks: List<Task> = emptyList())

// Body for POST /tasks. bucket/priority/dueDate are the fields FEATURES.md's
// create flow exposes ("title, bucket, priority, optional due date").
@Serializable
data class CreateTaskRequest(
    val title: String,
    val bucket: String,
    val priority: Int = 50,
    @Serializable(with = InstantSerializer::class) val dueDate: Instant? = null,
)

// Body for PATCH /tasks/:id. Every field is optional and omitted-when-null:
// this app's ProtocolJson has explicitNulls = false, so a field left null
// here is dropped from the encoded body entirely rather than sent as
// `"field": null` and overwriting a value the edit screen never touched.
@Serializable
data class UpdateTaskRequest(
    val title: String? = null,
    val bucket: String? = null,
    val priority: Int? = null,
    val status: String? = null,
    @Serializable(with = InstantSerializer::class) val dueDate: Instant? = null,
)

// Body for POST /tasks/:id/complete. completedVia is never anything but
// "mobile" from this client — PROTOCOL.md §5 and FEATURES.md are both
// explicit that every mobile-originated completion says so.
@Serializable
data class CompleteTaskRequest(val completedVia: String = "mobile")

// DELETE /tasks/:id's response shape, verified against src/hosted-interface.js:
// `sendJson(res, ok ? 200 : 404, { ok, id })` — never a bare 204.
@Serializable
data class DeleteTaskResult(val ok: Boolean = false, val id: String = "")
