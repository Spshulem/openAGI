import ActivityKit
import SwiftUI
import WidgetKit

// The daemon supplies encrypted state. This surface only displays it and
// opens the exact session; answering stays in the authenticated app.
struct SupervisorLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SupervisorActivityAttributes.self) { context in
            SupervisorActivityView(plaintext: Self.open(context.state), stale: context.isStale)
                .activitySystemActionForegroundColor(.primary)
                .widgetURL(SupervisorLink.url())
        } dynamicIsland: { context in
            let plaintext = Self.open(context.state)
            let stale = context.isStale || plaintext?.isOutdated() != false
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Agent sessions", systemImage: "binoculars")
                        .font(.caption)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if stale { Label("Updates paused", systemImage: "wifi.exclamationmark").font(.caption) }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    SupervisorActivityView(plaintext: plaintext, stale: stale, compact: true)
                }
            } compactLeading: {
                if stale {
                    Image(systemName: "wifi.exclamationmark").accessibilityLabel("Session updates paused")
                } else {
                    Label("\(plaintext?.counts.you ?? 0)", systemImage: "person.fill.questionmark")
                        .foregroundStyle(.orange)
                }
            } compactTrailing: {
                Label("\(plaintext?.counts.working ?? 0)", systemImage: stale ? "clock" : "bolt.fill")
                    .foregroundStyle(stale ? Color.secondary : Color.green)
            } minimal: {
                if stale {
                    Image(systemName: "wifi.exclamationmark")
                } else if let count = plaintext?.counts.you, count > 0 {
                    Text("\(count)").foregroundStyle(.orange)
                } else if let count = plaintext?.counts.blocked, count > 0 {
                    Text("\(count)").foregroundStyle(.red)
                } else {
                    Image(systemName: "bolt.fill")
                }
            }
            .widgetURL(SupervisorLink.url(threadKey: plaintext?.rows.first?.key))
        }
    }

    static func open(_ state: SupervisorActivityAttributes.ContentState) -> SupervisorActivityPlaintext? {
        SupervisorActivityPlaintext.open(sealed: state.sealed, key: PushKeyStore.load())
    }
}

private struct SupervisorActivityView: View {
    let plaintext: SupervisorActivityPlaintext?
    let stale: Bool
    var compact = false

    private var outdated: Bool { stale || plaintext?.isOutdated() != false }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !compact { Text("Agent sessions").font(.headline) }
            if let plaintext {
                Text(plaintext.countsLine)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(outdated ? Color.secondary : Color.primary)
                if outdated {
                    Label("Updates paused · Showing last known sessions", systemImage: "wifi.exclamationmark")
                        .font(.caption).foregroundStyle(.secondary)
                } else if plaintext.partial {
                    Label("Some sessions unavailable", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(plaintext.rows.prefix(compact ? 1 : 2)) { row in
                    Link(destination: SupervisorLink.url(threadKey: row.key)) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: symbol(row.group))
                                .foregroundStyle(outdated ? Color.secondary : color(row.group))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).font(.subheadline).lineLimit(1).privacySensitive()
                                if let reason = row.waitingOn, !reason.isEmpty {
                                    Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
                                }
                            }
                        }
                    }
                    .accessibilityLabel("Open session: \(row.title)")
                }
                HStack {
                    if let row = plaintext.rows.first {
                        Link(destination: SupervisorLink.url(threadKey: row.key)) {
                            Label(row.group == "you" || row.group == "blocked" ? "Review" : "Open session", systemImage: "arrow.up.forward.app")
                        }
                    }
                    Spacer()
                    Link("Sessions", destination: SupervisorLink.url())
                }
                .font(.caption.weight(.semibold))
                if let date = plaintext.observedDate {
                    HStack(spacing: 3) {
                        Text("Last scan")
                        Text(date, style: .relative)
                        Text("ago")
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text(SupervisorActivityPlaintext.unreadableLine).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(compact ? 0 : 16)
    }

    private func symbol(_ group: String) -> String {
        switch group {
        case "you": return "person.fill.questionmark"
        case "blocked": return "exclamationmark.octagon"
        case "working": return "bolt.fill"
        default: return "hourglass"
        }
    }

    private func color(_ group: String) -> Color {
        switch group {
        case "you": return .orange
        case "blocked": return .red
        case "working": return .green
        default: return .secondary
        }
    }
}
