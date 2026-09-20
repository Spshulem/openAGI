import Foundation

// Pure formatting, deliberately free of any View/Date-now dependency so it
// is trivial to test at exact minute boundaries. Two shapes are needed:
// the compact form the connection line uses next to the host ("2m", "3h"),
// and the full sentence DESIGN.md's copy rules specify for a stale widget
// ("Last synced 3h ago").
public enum RelativeTime {
    // Connection line: "<dot> host · <compact>".
    public static func compact(minutes: Int) -> String {
        let minutes = max(0, minutes)
        if minutes == 0 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    // DESIGN.md: "Last synced 3h ago" — state the fact, do not say "offline"
    // when that isn't known.
    public static func lastSynced(minutes: Int) -> String {
        let minutes = max(0, minutes)
        if minutes == 0 { return "Last synced just now" }
        return "Last synced \(compact(minutes: minutes)) ago"
    }

    // TodayView / SettingsView's fuller "Updated 2m ago" status line.
    public static func updated(minutes: Int) -> String {
        let minutes = max(0, minutes)
        return minutes == 0 ? "Updated just now" : "Updated \(compact(minutes: minutes)) ago"
    }
}
