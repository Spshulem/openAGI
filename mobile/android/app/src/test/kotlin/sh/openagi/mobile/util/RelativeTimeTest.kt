package sh.openagi.mobile.util

import org.junit.Assert.assertEquals
import org.junit.Test

// RelativeTime backs the connection line on every screen and the widget's
// own staleness copy (DESIGN.md's exact "Last synced 3h ago"), but had no
// pinned test of its own — these fix the table of (minutes -> phrase) in
// place so a future edit can't silently change what "stale" looks like.
class RelativeTimeTest {
    @Test
    fun zeroOrNegativeMinutesReadsAsJustNow() {
        assertEquals("just now", RelativeTime.short(0))
        assertEquals("just now", RelativeTime.short(-5))
    }

    @Test
    fun underAnHourIsMinutes() {
        assertEquals("1m", RelativeTime.short(1))
        assertEquals("45m", RelativeTime.short(45))
        assertEquals("59m", RelativeTime.short(59))
    }

    @Test
    fun underADayIsHours() {
        assertEquals("1h", RelativeTime.short(60))
        assertEquals("3h", RelativeTime.short(3 * 60))
        assertEquals("23h", RelativeTime.short(23 * 60))
    }

    @Test
    fun aDayOrMoreIsDays() {
        assertEquals("1d", RelativeTime.short(24 * 60))
        assertEquals("2d", RelativeTime.short(2 * 24 * 60))
    }

    @Test
    fun updatedPhraseMatchesTodayScreensStatusLine() {
        assertEquals("Updated just now", RelativeTime.updated(0))
        assertEquals("Updated 2m ago", RelativeTime.updated(2))
        assertEquals("Updated 3h ago", RelativeTime.updated(3 * 60))
    }

    @Test
    fun lastSyncedMatchesDesignMdsExactStaleWidgetCopy() {
        assertEquals("Last synced 3h ago", RelativeTime.lastSynced(3 * 60))
    }
}
