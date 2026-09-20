import Foundation
import WidgetKit

// The identifier both processes must agree on: WidgetCenter matches a
// reload request to a widget by exactly this string. Defined once, here in
// Sources/ (not inside the `Widget`-conforming `TodayWidget`, which is
// implicitly @MainActor-isolated and so cannot be read from the AppIntent's
// non-isolated `perform()`), so the widget's own declaration and every
// caller that reloads it -- the app's RefreshCoordinator and this
// extension's own CompleteTaskIntent -- cannot drift apart.
public enum TodayWidgetKind {
    public static let value = "TodayWidget"
}

// The one state machine both the iOS and Android widgets render from. Pure
// function on purpose: it takes `paired` as a parameter instead of reading
// the Keychain itself, because a unit-test bundle cannot arrange Keychain
// state, and because this keeps it the literal twin of Android's
// `WidgetState.from`. The timeline provider is what actually supplies
// `paired: Credentials.load() != nil` -- this type never touches Security.framework.
public enum WidgetState: Equatable, Sendable {
    case unpaired
    case empty(headline: String)
    case tasks([TaskItem], counts: MobileSummary.Counts, ageMinutes: Int)
    case stale(Int)

    // Past this many minutes, the widget must say the data is stale rather
    // than present old rows as though they were current.
    public static let staleAfterMinutes = 60

    public static func from(snapshot: Snapshot?, paired: Bool, now: Date = Date()) -> WidgetState {
        guard paired else { return .unpaired }
        guard let snapshot else { return .empty(headline: "Nothing synced yet.") }
        let age = snapshot.ageInMinutes(now: now)
        if age > staleAfterMinutes { return .stale(age) }
        let visible = snapshot.visibleToday
        if visible.isEmpty { return .empty(headline: snapshot.summary.brief.headline) }
        return .tasks(visible, counts: snapshot.visibleCounts, ageMinutes: age)
    }
}

// What the timeline provider hands to WidgetKit: a render-ready state plus
// the date it was computed for.
public struct TodayEntry: TimelineEntry {
    public let date: Date
    public let state: WidgetState

    public init(date: Date, state: WidgetState) {
        self.date = date
        self.state = state
    }
}
