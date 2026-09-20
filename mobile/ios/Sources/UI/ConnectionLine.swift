import SwiftUI

// DESIGN.md: "Dot (6pt, live filled when synced under 60 min, muted hollow
// when older, alert filled when the last refresh failed) + host in mono +
// relative time in caption. Appears under every screen title." This is the
// app's honest, always-visible answer to "is the daemon alive right now" —
// never a modal, never animated (the dot changes state without animating).
public enum ConnectionDotState: Equatable, Sendable {
    case fresh
    case stale
    case failed

    // `refreshFailed` takes precedence: knowing the last attempt to reach
    // the daemon failed is a stronger, more specific signal than merely
    // "this is old data" — DESIGN.md's copy rules draw the same line
    // between "Can't reach OpenAGI" (an error, alert) and "Last synced 3h
    // ago" (a fact, muted).
    public static func derive(ageMinutes: Int, refreshFailed: Bool, freshWithinMinutes: Int = 60) -> ConnectionDotState {
        if refreshFailed { return .failed }
        return ageMinutes < freshWithinMinutes ? .fresh : .stale
    }

    var color: Color {
        switch self {
        case .fresh: return Theme.live
        case .stale: return Theme.muted
        case .failed: return Theme.alert
        }
    }

    var filled: Bool {
        switch self {
        case .fresh, .failed: return true
        case .stale: return false
        }
    }
}

// The 6pt dot alone — reused by the widget, which draws its own compact
// header rather than the full `ConnectionLineView` below.
public struct ConnectionDot: View {
    let state: ConnectionDotState

    public init(state: ConnectionDotState) {
        self.state = state
    }

    public var body: some View {
        Circle()
            .strokeBorder(state.color, lineWidth: state.filled ? 0 : 1.25)
            .background(Circle().fill(state.filled ? state.color : Color.clear))
            .frame(width: 6, height: 6)
            // The dot changes state without animating — DESIGN.md's motion
            // rule is explicit that this is not one of the app's animations.
            .transaction { $0.animation = nil }
    }
}

// The full line: dot + host (mono) + relative time (caption). Sits directly
// under every screen title, never centred, never inside a card.
public struct ConnectionLineView: View {
    let host: String
    let ageMinutes: Int
    let refreshFailed: Bool

    public init(host: String, ageMinutes: Int, refreshFailed: Bool) {
        self.host = host
        self.ageMinutes = ageMinutes
        self.refreshFailed = refreshFailed
    }

    public var body: some View {
        let state = ConnectionDotState.derive(ageMinutes: ageMinutes, refreshFailed: refreshFailed)
        HStack(spacing: Theme.Spacing.x1) {
            ConnectionDot(state: state)
            Text(host)
                .font(Theme.Typography.dataMono)
                .foregroundStyle(Theme.muted)
            Text("·")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.muted)
            Text(refreshFailed ? "Can't reach OpenAGI" : RelativeTime.compact(minutes: ageMinutes))
                .font(Theme.Typography.caption)
                .foregroundStyle(refreshFailed ? Theme.alert : Theme.muted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            refreshFailed
                ? "Can't reach \(host)"
                : "Connected to \(host), last synced \(RelativeTime.compact(minutes: ageMinutes)) ago"
        )
    }
}
