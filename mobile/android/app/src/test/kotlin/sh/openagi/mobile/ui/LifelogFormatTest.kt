package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.openagi.mobile.protocol.LifelogMoment
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class LifelogFormatTest {
    private val utc = ZoneId.of("UTC")

    private fun moment(id: String, at: String, endAt: String? = null, title: String = "", transcript: String = "") =
        LifelogMoment(id, "g2-1", "Glasses", Instant.parse(at), endAt?.let { Instant.parse(it) }, title, null, transcript)

    @Test
    fun momentsGroupByLocalDayNewestFirst() {
        val groups = LifelogFormat.byDay(
            listOf(
                moment("a", "2026-09-27T10:00:00Z"),
                moment("b", "2026-09-28T09:00:00Z"),
                moment("c", "2026-09-28T18:00:00Z"),
            ),
            utc,
        )
        assertEquals(listOf(LocalDate.of(2026, 9, 28), LocalDate.of(2026, 9, 27)), groups.map { it.first })
        assertEquals(listOf("c", "b"), groups[0].second.map { it.id })
        // The same instant can be another day in another zone.
        val tokyo = LifelogFormat.byDay(listOf(moment("a", "2026-09-27T20:00:00Z")), ZoneId.of("Asia/Tokyo"))
        assertEquals(LocalDate.of(2026, 9, 28), tokyo[0].first)
    }

    @Test
    fun daysReadAsTodayYesterdayOrADate() {
        val today = LocalDate.of(2026, 9, 28)
        assertEquals("Today", LifelogFormat.dayLabel(today, today))
        assertEquals("Yesterday", LifelogFormat.dayLabel(today.minusDays(1), today))
        assertEquals(true, LifelogFormat.dayLabel(LocalDate.of(2025, 1, 2), today).endsWith("2025"))
    }

    @Test
    fun aTitleFallsBackToTheFirstWords() {
        assertEquals("Ship it", LifelogFormat.title(moment("a", "2026-09-28T10:00:00Z", title = " Ship it ")))
        assertEquals("Sam: hello", LifelogFormat.title(moment("a", "2026-09-28T10:00:00Z", transcript = "\nSam: hello\nmore")))
        assertEquals("Conversation", LifelogFormat.title(moment("a", "2026-09-28T10:00:00Z")))
    }

    @Test
    fun aMomentWithNoLengthShowsOneTime() {
        val single = LifelogFormat.timeRange(moment("a", "2026-09-28T14:00:00Z", "2026-09-28T14:00:00Z"), utc)
        val range = LifelogFormat.timeRange(moment("a", "2026-09-28T14:00:00Z", "2026-09-28T14:20:00Z"), utc)
        assertEquals(false, single.contains("–"))
        assertEquals(true, range.contains("–"))
    }
}
