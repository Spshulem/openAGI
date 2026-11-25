import SupervisorChannelsKit
import SwiftUI

// Needs You on iPhone and iPad: compact native list rows (what needs a
// decision and one line of why) that push one decision screen (goal, where
// it stands, why it needs you, the decision, actions, then evidence and the
// conversation). On a wide layout the same screen sits beside the list. The
// same SupervisorNeedsYouDigest drives the Mac inspector.

extension SupervisorCard {
    var needsYouDigest: SupervisorNeedsYouDigest {
        let pr = prContext?.ref ?? prRef
        // Where it stands: the hub's short current state, else what changed.
        // When both are there, what changed leads the evidence.
        let current = brief?.currentState
        let changed = brief?.whatChanged ?? summary
        return SupervisorNeedsYouDigest(
            headline: headline,
            goal: brief?.context,
            state: current ?? changed,
            blocker: decisionFact,
            decision: brief?.decision,
            recommendation: recommendation ?? plan?.nextAction,
            evidence: [current == nil ? nil : changed, agentSummary, pr.map { "Pull request \($0)" }]
        )
    }

    var needsYouBadge: SupervisorNeedsYouBadge? {
        SupervisorNeedsYouBadge.make(kind: kind, risky: risky, ciState: ciState)
    }

    var needsYouProject: String {
        SupervisorChannelGrouping.normalizeProject(explicit: project, repo: repo, workspace: workspace)
    }

    /// "/Checkout · 3h ago": where it is and how long it has waited.
    func needsYouMeta(now: Date = Date()) -> String? {
        let leaf = subchannel.flatMap { $0.split(separator: "/").last.map(String.init) }
        let parts = [leaf.map { "/\($0)" }, noticedAt.map { SupervisorFormat.agoPhrase($0, now: now) }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var needsYouPullRequestURL: URL? {
        (prContext?.url ?? prUrl).flatMap { URL(string: $0) }
    }
}

extension SupervisorNeedsYouBadge.Tone {
    var color: Color {
        switch self {
        case .neutral: return Theme.muted
        case .caution: return Theme.caution
        case .alert: return Theme.alert
        }
    }
}

/// What one decision offers, in the order the detail shows it: the decision
/// itself (the agent's options, or the card's primary action), replying in
/// the Supervisor chat, and dismissing.
struct NeedsYouActions: Equatable {
    let decisions: [SupervisorCardAction]
    let canReply: Bool
    let dismiss: SupervisorCardAction

    init(card: SupervisorCard) {
        let hasThread = card.threadKey != nil || !card.threadKeys.isEmpty
        let op = card.primaryAction?.op
        let isCompletion = card.kind == "completed" || op == "open_chat"
        let isExplicitAction = ["merge_ready", "pr_ready", "ci_failed", "preference"].contains(card.kind ?? "")
            || ["merge", "fix_ci", "preference", "set_preference"].contains(op ?? "")
        let dismissAction = SupervisorCardAction(op: "dismiss", label: "Dismiss", value: "dismiss")

        if isCompletion {
            decisions = []
            dismiss = dismissAction
        } else if isExplicitAction, let primary = card.primaryAction, !primary.label.isEmpty {
            let extra = card.extraActions.first { $0.op != "defer" && $0.op != "dismiss" && !$0.destructive && !$0.label.isEmpty }
            decisions = [primary] + (extra.map { [$0] } ?? [])
            if let secondary = card.secondaryAction {
                // "Later" defers the card; it leaves Needs You like Dismiss.
                dismiss = secondary.label == "Later"
                    ? SupervisorCardAction(op: secondary.op, label: "Dismiss", value: secondary.value, destructive: secondary.destructive)
                    : secondary
            } else {
                dismiss = dismissAction
            }
        } else {
            let options = card.options
                .filter { !$0.isEmpty && $0.lowercased() != "open thread" && $0.lowercased() != "dismiss" }
                .prefix(4)
                .map { SupervisorCardAction(op: "answer", label: Self.capitalizedFirst($0), value: $0) }
            if !options.isEmpty {
                decisions = Array(options)
            } else if let primary = card.primaryAction, !primary.label.isEmpty, primary.op != "dismiss" {
                decisions = [primary]
            } else {
                decisions = []
            }
            dismiss = dismissAction
        }
        canReply = card.canReply || hasThread
    }

    private static func capitalizedFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }
}

/// One Needs You row: a title, one line of why, and a quiet meta line.
struct NeedsYouRowLabel: View {
    let card: SupervisorCard
    let reason: String?
    var isUpdate: Bool = false

    @ScaledMetric(relativeTo: .subheadline) private var dotSize: CGFloat = 7

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            statusMark
            VStack(alignment: .leading, spacing: 3) {
                Text(card.headline)
                    .font(.subheadline.weight(isUpdate ? .regular : .semibold))
                    .foregroundStyle(isUpdate ? Theme.muted : Theme.ink)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                if let reason, !reason.isEmpty {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                let badge = isUpdate ? nil : card.needsYouBadge
                let meta = card.needsYouMeta()
                if badge != nil || meta != nil {
                    HStack(spacing: 6) {
                        if let badge {
                            Text(badge.text)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(badge.tone.color)
                        }
                        if let meta {
                            Text(meta)
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusMark: some View {
        if isUpdate {
            Image(systemName: "checkmark.circle")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
        } else {
            Circle()
                .fill(dotColor)
                .frame(width: dotSize, height: dotSize)
                .accessibilityHidden(true)
        }
    }

    private var dotColor: Color {
        switch card.needsYouBadge?.tone {
        case .alert?: return Theme.alert
        case .caution?: return Theme.caution
        default: return Theme.muted.opacity(0.5)
        }
    }
}

/// The one decision screen: pushed on iPhone, beside the list when wide.
struct NeedsYouDetailView: View {
    /// Nil once the decision was answered or dismissed elsewhere.
    let card: SupervisorCard?
    let isBusy: Bool
    /// False beside the list, where the screen keeps its own title.
    var showsTitle: Bool = true
    let onAct: (SupervisorCard, SupervisorCardAction) -> Void
    let onReplyInChat: (SupervisorCard) -> Void
    let onOpenContext: (SupervisorCard) -> Void

    var body: some View {
        Group {
            if let card {
                content(card)
            } else {
                ContentUnavailableView(
                    "No longer waiting",
                    systemImage: "checkmark.circle",
                    description: Text("This was answered or dismissed.")
                )
            }
        }
        .modifier(DecisionTitle(isShown: showsTitle))
        .accessibilityIdentifier("needs-you-detail")
    }

    private func content(_ card: SupervisorCard) -> some View {
        let digest = card.needsYouDigest
        let actions = NeedsYouActions(card: card)
        return List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    if let badge = card.needsYouBadge {
                        Text(badge.text)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(badge.tone.color)
                    }
                    Text(digest.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    let meta = [
                        card.needsYouProject == "general" ? nil : "#\(card.needsYouProject)",
                        card.needsYouMeta()
                    ].compactMap { $0 }.joined(separator: " · ")
                    if !meta.isEmpty {
                        Text(meta)
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                    }
                    if card.blockingCount > 0 {
                        Label(card.blockingSummary ?? "Blocking \(card.blockingCount) downstream", systemImage: "exclamationmark.triangle")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Theme.caution)
                    }
                }
                .padding(.vertical, 2)
            }

            ForEach(digest.sections.filter { $0.kind != .evidence }) { section in
                Section(section.title) {
                    MarkdownContent(blocks: MarkdownParser.parse(section.text))
                        .font(.subheadline)
                        .textSelection(.enabled)
                }
            }

            Section {
                ForEach(Array(actions.decisions.enumerated()), id: \.offset) { index, action in
                    Button {
                        onAct(card, action)
                    } label: {
                        Text(action.label)
                            .fontWeight(index == 0 && !card.risky ? .semibold : .regular)
                    }
                    .disabled(isBusy)
                    .accessibilityIdentifier("needs-you-action-\(index)")
                }
                if actions.canReply {
                    Button {
                        onReplyInChat(card)
                    } label: {
                        Label("Reply in Supervisor chat", systemImage: "arrowshape.turn.up.left")
                    }
                    .accessibilityIdentifier("needs-you-reply")
                }
                Button {
                    onAct(card, actions.dismiss)
                } label: {
                    Text(actions.dismiss.label)
                        .foregroundStyle(Theme.muted)
                }
                .disabled(isBusy)
                .accessibilityIdentifier("needs-you-dismiss")
            } header: {
                Text(actions.decisions.isEmpty ? "Actions" : "Decide")
            } footer: {
                if isBusy {
                    Text("Sending…")
                }
            }

            let evidence = digest.sections(.evidence)
            if !evidence.isEmpty {
                Section("Evidence") {
                    ForEach(evidence) { item in
                        MarkdownContent(blocks: MarkdownParser.parse(item.text))
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                            .textSelection(.enabled)
                    }
                }
            }

            Section {
                Button {
                    onOpenContext(card)
                } label: {
                    Label("Conversation and sources", systemImage: "text.bubble")
                }
                .accessibilityIdentifier("needs-you-conversation")
                if let url = card.needsYouPullRequestURL {
                    Link(destination: url) {
                        Label("Open pull request", systemImage: "arrow.up.right.square")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

private struct DecisionTitle: ViewModifier {
    let isShown: Bool

    func body(content: Content) -> some View {
        if isShown {
            content
                .navigationTitle("Decision")
                .navigationBarTitleDisplayMode(.inline)
        } else {
            content
        }
    }
}

/// Pushes one decision on the Supervisor's navigation stack.
struct NeedsYouRoute: Hashable {
    let cardID: String
}
