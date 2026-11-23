import SupervisorChannelsKit
import SwiftUI

// Needs You on the Mac: compact rows in the list (what needs a decision and
// one line of why), and one detail surface in the inspector (goal, where it
// stands, why it needs you, decision, actions, then evidence and the
// conversation). The same SupervisorNeedsYouDigest drives the iPhone screens.

extension FleetQuestion {
  /// This question as a digest, with the hub card's brief when there is one.
  func needsYouDigest(card: FleetCardBrief?) -> SupervisorNeedsYouDigest {
    let body = self.body.trimmingCharacters(in: .whitespacesAndNewlines)
    let nextAction = plan?.nextAction
    let decision = isClarificationQuestion
      ? (nextAction ?? card?.decision ?? body)
      : (card?.decision ?? body)
    let prRef = card?.prRef ?? self.prRef
    return SupervisorNeedsYouDigest(
      headline: decisionHeadline ?? title,
      goal: card?.context,
      state: card?.whatChanged,
      blocker: decisionFact,
      decision: decision,
      recommendation: card?.recommendation ?? (isClarificationQuestion ? nil : nextAction),
      evidence: [displayAskContext, reviewNote, prRef.map { "Pull request \($0)" }]
    )
  }

  func needsYouBadge(card: FleetCardBrief?) -> SupervisorNeedsYouBadge? {
    SupervisorNeedsYouBadge.make(kind: card?.kind ?? kind, risky: risky, ciState: card?.ciState)
  }

  /// "/Checkout · 3h ago": where it is and how long it has waited.
  func needsYouMeta(now: Date = Date()) -> String? {
    let leaf = subchannel.flatMap { $0.split(separator: "/").last.map(String.init) }
    let age = askedTime.flatMap(FleetWatching.parseDate).map { FleetThreadSummary.ago($0, now: now) }
    let parts = [leaf.map { "/\($0)" }, age].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

extension SupervisorNeedsYouBadge.Tone {
  var color: Color {
    switch self {
    case .neutral: return WorkspaceTheme.muted
    case .caution: return WorkspaceTheme.caution
    case .alert: return WorkspaceTheme.alert
    }
  }
}

/// One Needs You item in a list: a title and one line of why. The whole row
/// is the click target; it selects the item and opens it in the inspector.
struct NeedsYouRow: View {
  let title: String
  let reason: String?
  let badge: SupervisorNeedsYouBadge?
  let meta: String?
  let isSelected: Bool
  /// An FYI or completion: quieter, with no status dot.
  var isUpdate: Bool = false
  let action: () -> Void

  @State private var isHovering = false

  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: WorkspaceTheme.Spacing.x2 + 2) {
        statusMark
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(WorkspaceTheme.Typography.body.weight(isUpdate ? .regular : .medium))
            .foregroundStyle(isUpdate ? WorkspaceTheme.muted : WorkspaceTheme.ink)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          if let reason, !reason.isEmpty {
            Text(reason)
              .font(WorkspaceTheme.Typography.secondary)
              .foregroundStyle(WorkspaceTheme.muted)
              .lineLimit(1)
              .truncationMode(.tail)
          }
        }
        Spacer(minLength: WorkspaceTheme.Spacing.x3)
        if let badge {
          Text(badge.text)
            .font(.caption.weight(.medium))
            .foregroundStyle(badge.tone.color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(badge.tone.color.opacity(0.12), in: Capsule())
            .fixedSize()
        }
        if let meta {
          Text(meta)
            .font(.caption.monospacedDigit())
            .foregroundStyle(WorkspaceTheme.muted)
            .lineLimit(1)
            .fixedSize()
        }
      }
      .padding(.vertical, 7)
      .padding(.horizontal, WorkspaceTheme.Spacing.x3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(rowBackground, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
    .buttonStyle(.plain)
    .onHover { isHovering = $0 }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    .accessibilityHint("Opens it in the inspector")
  }

  @ViewBuilder
  private var statusMark: some View {
    if isUpdate {
      Image(systemName: "checkmark.circle")
        .font(.caption)
        .foregroundStyle(WorkspaceTheme.muted)
        .accessibilityHidden(true)
    } else {
      Circle()
        .fill(dotColor)
        .frame(width: 7, height: 7)
        .accessibilityHidden(true)
    }
  }

  private var dotColor: Color {
    switch badge?.tone {
    case .alert?: return WorkspaceTheme.alert
    case .caution?: return WorkspaceTheme.caution
    default: return WorkspaceTheme.muted.opacity(0.55)
    }
  }

  private var rowBackground: Color {
    if isSelected { return Color.accentColor.opacity(0.16) }
    if isHovering { return WorkspaceTheme.surfaceFill.opacity(0.7) }
    return .clear
  }
}

/// A quiet group header: the project name and how many wait on you.
struct NeedsYouGroupHeader: View {
  let title: String
  let count: Int
  var onOpen: (() -> Void)? = nil

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(WorkspaceTheme.muted)
      Text("\(count)")
        .font(.caption.monospacedDigit())
        .foregroundStyle(WorkspaceTheme.muted.opacity(0.8))
      Spacer()
      if let onOpen {
        Button("Open channel", action: onOpen)
          .buttonStyle(.borderless)
          .font(.caption)
          .foregroundStyle(WorkspaceTheme.muted)
      }
    }
    .padding(.horizontal, WorkspaceTheme.Spacing.x3)
    .padding(.top, WorkspaceTheme.Spacing.x2)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

/// Digest sections of the given kinds, each a small caption title over its
/// text, in the digest's order.
struct NeedsYouSections: View {
  let digest: SupervisorNeedsYouDigest
  let kinds: Set<SupervisorNeedsYouDigest.SectionKind>

  var body: some View {
    let shown = digest.sections.filter { kinds.contains($0.kind) }
    ForEach(Array(shown.enumerated()), id: \.element.id) { index, section in
      VStack(alignment: .leading, spacing: 3) {
        // Several evidence items share one heading.
        if index == 0 || shown[index - 1].kind != section.kind {
          Text(section.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.muted)
            .accessibilityAddTraits(.isHeader)
        }
        WorkspaceMarkdownContent(
          blocks: WorkspaceMarkdownParser.parse(section.text),
          bodyFont: WorkspaceTheme.Typography.secondary,
          textColor: WorkspaceTheme.ink
        )
        .textSelection(.enabled)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
