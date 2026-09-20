package sh.openagi.mobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable
data class TaskItem(
    val id: String,
    val title: String,
    val bucket: String,
    val status: String,
    val priority: Int = 50,
    @Serializable(with = InstantSerializer::class) val dueDate: Instant? = null,
    val overdue: Boolean = false,
)

@Serializable
data class Counts(
    val today: Int = 0,
    @SerialName("this_week") val thisWeek: Int = 0,
    val overdue: Int = 0,
    val pendingActions: Int = 0,
)

@Serializable
data class PendingActionSummary(
    val id: String,
    val summary: String,
    @Serializable(with = InstantSerializer::class) val createdAt: Instant? = null,
)

@Serializable
data class Brief(val headline: String = "")

@Serializable
data class MobileSummary(
    @Serializable(with = InstantSerializer::class) val generatedAt: Instant,
    val today: List<TaskItem> = emptyList(),
    val counts: Counts = Counts(),
    val pendingActions: List<PendingActionSummary> = emptyList(),
    val brief: Brief = Brief(),
)

@Serializable
data class Enrollment(
    val node: Node,
    val nodeToken: String,
) {
    @Serializable
    data class Node(val id: String, val name: String, val platform: String)
}
