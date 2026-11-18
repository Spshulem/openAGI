package sh.openagi.mobile.sync

import org.junit.Assert.*
import org.junit.Test
import sh.openagi.mobile.protocol.*
import java.time.Instant

class SessionOverviewTest {
    private val now = Instant.parse("2026-10-28T12:00:00Z")
    private fun thread(key: String, group: String) = FleetThread(key = key, title = "Session $key", watch = FleetWatch(group = group))

    @Test fun countsUniqueSessionsAndChoosesTheOneNeedingYou() {
        val blocked = thread("b", "blocked").copy(reason = "Sign in required")
        val overview = SessionOverview.from(FleetState(snapshot = FleetSnapshot(at = now, threads = listOf(
            thread("run", "working"), blocked, blocked, thread("answer", "you"), thread("", "working"), thread("quiet", "quiet")))))
        assertEquals("1 needs you · 1 blocked · 1 working", overview.countsLine)
        assertEquals("answer", overview.first?.key)
        assertTrue(overview.active)
        assertFalse(overview.stale(now))
        val onlyBlocked = SessionOverview.from(FleetState(snapshot = FleetSnapshot(at = now, threads = listOf(blocked))))
        assertTrue(onlyBlocked.active)
        assertEquals("Session b — Sign in required", onlyBlocked.detail)
    }

    @Test fun oldScanOrDisconnectedServerNeverLooksLive() {
        val overview = SessionOverview.from(FleetState(snapshot = FleetSnapshot(at = now.minusSeconds(3600), threads = listOf(thread("a", "working")))))
        assertEquals("Session updates paused", overview.title(now, false))
        assertTrue(overview.body(now, false).contains("60m ago"))
        assertEquals("Can't reach server · Last known sessions", overview.title(now, true))
        assertTrue(overview.body(now, true).contains("1 working"))
        assertTrue(SessionOverview.from(FleetState()).stale(now))
    }

    @Test fun reconnectReplacesCountsAndFreshness() {
        val old = SessionOverview.from(FleetState(snapshot = FleetSnapshot(at = now.minusSeconds(1800), threads = listOf(thread("a", "working")))))
        assertTrue(old.stale(now))
        val fresh = SessionOverview.from(FleetState(snapshot = FleetSnapshot(at = now, threads = listOf(thread("b", "blocked")))))
        assertEquals("1 blocked", fresh.title(now, false))
        assertEquals("b", fresh.first?.key)
        assertFalse(fresh.stale(now))
        assertEquals("No active sessions", SessionOverview.from(FleetState(snapshot = FleetSnapshot(at = now))).countsLine)
    }
}
