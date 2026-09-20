import WidgetKit
import Foundation

// The widget never performs network I/O: the app owns refresh, the widget
// owns rendering. This only reads what the app (or CompleteTaskIntent) has
// already written into the App Group container, and the Keychain for the
// one bit of state (paired or not) that WidgetState.from needs but cannot
// read for itself.
struct TodayTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(
            date: Date(),
            state: .tasks(
                [TaskItem(id: "placeholder", title: "Sample task", bucket: "today", status: "pending",
                          priority: 50, dueDate: nil, overdue: false)],
                counts: .init(today: 1, thisWeek: 0, overdue: 0, pendingActions: 0),
                ageMinutes: 0
            )
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let entry = currentEntry()
        // The app refreshes in the background and reloads our timeline
        // whenever new data lands; this policy is only the fallback in case
        // that never happens (e.g. background refresh got throttled), so the
        // age line still ticks forward and can reach `.stale`.
        let nextRefresh = Date().addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }

    private func currentEntry() -> TodayEntry {
        let snapshot = SnapshotStore().load()
        let paired = Credentials.load() != nil
        return TodayEntry(date: Date(), state: WidgetState.from(snapshot: snapshot, paired: paired))
    }
}
