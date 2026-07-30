import SwiftUI

// Renders the ranked brief. Every button comes from the server's declarative
// `actions`, so this view has no per-kind switch and needs no change when a
// new source is added server-side.
struct BriefSection: View {
  @ObservedObject var brief = BriefConsumer.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text("TODAY").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        if !brief.items.isEmpty {
          Text("\(brief.items.count) things").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        Spacer()
        if brief.isLoading { ProgressView().controlSize(.small) }
      }

      if brief.items.isEmpty && !brief.isLoading {
        Text("Nothing needs you right now.").font(.system(size: 11)).foregroundStyle(.tertiary)
      }

      ForEach(brief.items) { item in
        row(item)
      }

      // Two distinct channels. A transport/HTTP failure is always an error (red).
      // An outcome is informational (secondary) — EXCEPT that the accept endpoint
      // reports failures as 200s with a *Error field, so outcomeMessage prefixes
      // those with "Failed:" and they must still read as failures.
      if let err = brief.lastError {
        Text(err).font(.system(size: 10)).foregroundStyle(.red).lineLimit(2)
      }
      if let outcome = brief.lastOutcome {
        Text(outcome).font(.system(size: 10))
          .foregroundStyle(outcome.hasPrefix("Failed") ? .red : .secondary)
          .lineLimit(2)
      }

      if brief.olderCount > 0 {
        Text("▾ \(brief.olderCount) older").font(.system(size: 10)).foregroundStyle(.tertiary)
      }
    }
  }

  @ViewBuilder private func row(_ item: BriefItem) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .top, spacing: 5) {
        Text(icon(item.kind)).font(.system(size: 11))
        Text(item.title).font(.system(size: 12, weight: .semibold)).lineLimit(2)
      }
      if !item.why.isEmpty {
        Text(item.why).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
      }
      if !item.actions.isEmpty {
        HStack(spacing: 6) {
          ForEach(item.actions) { action in
            Button(action.label) { Task { await brief.act(item, action) } }
              .buttonStyle(.borderless)
              .font(.system(size: 11))
              .foregroundStyle(tint(action.style))
              .disabled(brief.inFlight.contains(item.id))
          }
        }
      }
    }
  }

  private func icon(_ kind: String) -> String {
    switch kind {
    case "focus": return "🎯"
    case "task": return "✓"
    case "suggestion": return "💡"
    case "draft": return "📝"
    case "clarification": return "❓"
    default: return "•"
    }
  }

  private func tint(_ style: String) -> Color {
    switch style {
    case "primary": return .blue
    case "destructive": return .red
    default: return .secondary
    }
  }
}
