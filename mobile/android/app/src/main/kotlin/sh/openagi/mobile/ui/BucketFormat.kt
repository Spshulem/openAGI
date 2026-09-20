package sh.openagi.mobile.ui

// The bucket order every section list (Tasks screen) walks, and the label
// each renders as — pure so it's trivially testable and shared between the
// section list and the editor's bucket picker.
object BucketFormat {
    val ORDER = listOf("today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done")

    fun label(bucket: String): String = when (bucket) {
        "today" -> "Today"
        "this_week" -> "This week"
        "this_month" -> "This month"
        "this_quarter" -> "This quarter"
        "this_year" -> "This year"
        "someday" -> "Someday"
        "done" -> "Done"
        else -> bucket
    }

    fun statusLabel(status: String): String = when (status) {
        "pending" -> "Pending"
        "in_progress" -> "In progress"
        "blocked" -> "Blocked"
        "completed" -> "Completed"
        "cancelled" -> "Cancelled"
        else -> status
    }

    val STATUSES = listOf("pending", "in_progress", "blocked", "completed", "cancelled")
}
