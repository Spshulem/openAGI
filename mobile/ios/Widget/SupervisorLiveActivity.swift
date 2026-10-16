import ActivityKit
import SwiftUI
import WidgetKit

// The supervisor's Live Activity: started, updated and ended by push from the
// daemon (through the relay), never by the app. Its content state is only
// ciphertext, opened here with the push key at draw time; a state that will
// not open shows one plain line rather than anything half-decoded.
struct SupervisorLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SupervisorActivityAttributes.self) { context in
            SupervisorLockScreenView(plaintext: Self.open(context.state))
                .activityBackgroundTint(Theme.canvas)
                .activitySystemActionForegroundColor(Theme.ink)
                .widgetURL(Self.supervisorURL)
        } dynamicIsland: { context in
            let plaintext = Self.open(context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Supervisor", systemImage: "binoculars")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.muted)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    SupervisorRowsView(plaintext: plaintext, maxRows: 2)
                }
            } compactLeading: {
                CountBadge(count: plaintext?.counts.you, color: Theme.alert, systemImage: "person.fill")
            } compactTrailing: {
                CountBadge(count: plaintext?.counts.working, color: Theme.live, systemImage: "bolt.fill")
            } minimal: {
                if let you = plaintext?.counts.you, you > 0 {
                    Text("\(you)").font(.caption.weight(.semibold)).foregroundStyle(Theme.alert)
                } else {
                    Circle().fill(Theme.live).frame(width: 8, height: 8)
                }
            }
            .widgetURL(Self.supervisorURL)
        }
    }

    // Read on every draw: the key can change on re-pairing, and the system
    // may reuse this process across activities.
    static func open(_ state: SupervisorActivityAttributes.ContentState) -> SupervisorActivityPlaintext? {
        SupervisorActivityPlaintext.open(sealed: state.sealed, key: PushKeyStore.load())
    }

    // OpenAGIApp's onOpenURL turns this into the Supervisor tab.
    static let supervisorURL = URL(string: "openagi://supervisor")
}

private struct SupervisorLockScreenView: View {
    let plaintext: SupervisorActivityPlaintext?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            HStack(spacing: Theme.Spacing.x1) {
                Text("Supervisor")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
                Text(plaintext?.countsLine ?? "")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
            SupervisorRowsView(plaintext: plaintext, maxRows: 3)
        }
        .padding(Theme.Spacing.x4)
    }
}

private struct SupervisorRowsView: View {
    let plaintext: SupervisorActivityPlaintext?
    let maxRows: Int

    var body: some View {
        if let plaintext {
            VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                ForEach(plaintext.rows.prefix(maxRows)) { row in
                    HStack(spacing: Theme.Spacing.x2) {
                        Circle().fill(Self.color(for: row.group)).frame(width: 6, height: 6)
                        Text(row.title)
                            .font(Theme.Typography.secondary)
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        if let waitingOn = row.waitingOn, !waitingOn.isEmpty {
                            Text(waitingOn)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if let since = row.sinceDate {
                            Text(since, style: .relative)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.muted)
                                .monospacedDigit()
                                .lineLimit(1)
                                .frame(maxWidth: 70, alignment: .trailing)
                        }
                    }
                }
            }
        } else {
            Text(SupervisorActivityPlaintext.unreadableLine)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.muted)
        }
    }

    // Needs you is the alert hue, working the live one, waiting the
    // supervisor's caution yellow (Theme's one exception).
    static func color(for group: String) -> Color {
        switch group {
        case "you": return Theme.alert
        case "working": return Theme.live
        default: return Theme.caution
        }
    }
}

private struct CountBadge: View {
    let count: Int?
    let color: Color
    let systemImage: String

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: systemImage).foregroundStyle(color)
            Text(count.map(String.init) ?? "–")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
    }
}
