package sh.openagi.mobile.util

// Pure, deliberately: the connection line and the widget both render an age
// in minutes into the same short phrase, and this is the one place that
// phrasing is decided. No Android/Instant dependency so it is trivial to
// pin with a table of (minutes -> expected string) tests.
object RelativeTime {
    // "just now", "2m", "1h", "3h", "2d" — the compact form next to a host.
    fun short(ageMinutes: Int): String = when {
        ageMinutes <= 0 -> "just now"
        ageMinutes < 60 -> "${ageMinutes}m"
        ageMinutes < 60 * 24 -> "${ageMinutes / 60}h"
        else -> "${ageMinutes / (60 * 24)}d"
    }

    // "Updated just now" / "Updated 2m ago" — TodayScreen's status line.
    fun updated(ageMinutes: Int): String =
        if (ageMinutes <= 0) "Updated just now" else "Updated ${short(ageMinutes)} ago"

    // "Last synced 3h ago" — DESIGN.md's exact stale-widget copy, reused
    // wherever a screen or the widget must say a snapshot has gone stale
    // without claiming to know the daemon is offline.
    fun lastSynced(ageMinutes: Int): String = "Last synced ${short(ageMinutes)} ago"
}
