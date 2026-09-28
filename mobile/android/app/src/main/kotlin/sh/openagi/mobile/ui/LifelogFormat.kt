package sh.openagi.mobile.ui

import sh.openagi.mobile.protocol.LifelogMoment
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// The Lifelog screen's words and order, kept pure so tests can pin them.
object LifelogFormat {
    // Newest day first, each day's moments newest first, in the phone's zone.
    fun byDay(moments: List<LifelogMoment>, zone: ZoneId): List<Pair<LocalDate, List<LifelogMoment>>> =
        moments.sortedByDescending { it.at }
            .groupBy { it.at.atZone(zone).toLocalDate() }
            .toList()
            .sortedByDescending { it.first }

    fun dayLabel(day: LocalDate, today: LocalDate): String = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> DateTimeFormatter.ofPattern(if (day.year == today.year) "EEE, MMM d" else "EEE, MMM d, yyyy", Locale.getDefault()).format(day)
    }

    // "2:00 PM – 2:20 PM"; one time when the moment has no length.
    fun timeRange(moment: LifelogMoment, zone: ZoneId): String {
        val format = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()).withZone(zone)
        val start = format.format(moment.at)
        val end = moment.endAt?.takeIf { it.isAfter(moment.at) }?.let { format.format(it) }
        return if (end == null || end == start) start else "$start – $end"
    }

    fun title(moment: LifelogMoment): String =
        moment.title.trim().ifEmpty { moment.transcript.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(85) ?: "Conversation" }
}
