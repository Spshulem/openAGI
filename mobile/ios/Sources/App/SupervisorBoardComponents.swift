import SupervisorChannelsKit
import SwiftUI

struct BoardActorPill: View {
    let actor: String
    var isOwner: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: isOwner ? "person.fill" : "cpu")
                .font(.system(size: 9, weight: .semibold))
            Text(actor)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            (isOwner ? Theme.live : Color.accentColor).opacity(0.12),
            in: Capsule()
        )
        .foregroundStyle(isOwner ? Theme.live : Color.accentColor)
    }
}

struct BoardBlockingPill: View {
    let summary: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10, weight: .semibold))
            Text(summary)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.caution.opacity(0.14), in: Capsule())
        .foregroundStyle(Theme.caution)
    }
}

struct BoardQuietCheckPill: View {
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock")
                .font(.system(size: 9, weight: .semibold))
            Text(label)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.edge.opacity(0.6), lineWidth: 0.5))
        .foregroundStyle(Theme.muted)
    }
}

struct BoardMilestoneStrip: View {
    let milestones: [SupervisorMilestoneItem]

    var body: some View {
        if !milestones.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(milestones) { item in
                        HStack(spacing: 4) {
                            Image(systemName: icon(for: item.kind))
                                .font(.system(size: 10, weight: .semibold))
                            Text(item.badge)
                                .font(.caption2.weight(.bold))
                            Text(item.summary)
                                .font(.caption2)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(tint(for: item.kind).opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(tint(for: item.kind).opacity(0.28), lineWidth: 0.5)
                        )
                        .foregroundStyle(tint(for: item.kind))
                    }
                }
            }
        }
    }

    private func icon(for kind: SupervisorMilestoneKind) -> String {
        switch kind {
        case .decision: return "checkmark.seal.fill"
        case .question: return "questionmark.circle.fill"
        case .progress: return "bolt.fill"
        case .blocked: return "hand.raised.fill"
        case .pr: return "arrow.triangle.pull"
        case .commit: return "point.topleft.down.curvedto.point.bottomright.up"
        }
    }

    private func tint(for kind: SupervisorMilestoneKind) -> Color {
        switch kind {
        case .decision, .progress: return Theme.live
        case .question, .blocked: return Theme.caution
        case .pr: return .blue
        case .commit: return Theme.muted
        }
    }
}

private struct BoardLabelPillStyle: View {
    let label: SupervisorBoardLabel
    var selected: Bool = false

    var body: some View {
        HStack(spacing: 2) {
            Text(label.key)
                .foregroundStyle(selected ? .white.opacity(0.85) : Theme.muted)
            Text("=")
                .foregroundStyle(selected ? .white.opacity(0.65) : Theme.muted.opacity(0.7))
            Text(label.value)
                .fontWeight(.semibold)
        }
        .font(.caption2.monospaced())
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(selected ? Theme.live : Theme.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.edge.opacity(selected ? 0 : 0.6), lineWidth: 0.5))
        .foregroundStyle(selected ? Color.white : Theme.ink)
    }
}

struct BoardLabelChipsRow: View {
    let labels: [SupervisorBoardLabel]
    @Binding var activeFilters: Set<String>

    var body: some View {
        if !labels.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(labels) { item in
                        let selected = activeFilters.contains(item.raw.lowercased())
                        Button {
                            let key = item.raw.lowercased()
                            if selected {
                                activeFilters.remove(key)
                            } else {
                                activeFilters.insert(key)
                            }
                        } label: {
                            BoardLabelPillStyle(label: item, selected: selected)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

struct BoardReadOnlyLabelsRow: View {
    let labels: [SupervisorBoardLabel]

    var body: some View {
        if !labels.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(labels) { item in
                        BoardLabelPillStyle(label: item, selected: false)
                    }
                }
            }
        }
    }
}
