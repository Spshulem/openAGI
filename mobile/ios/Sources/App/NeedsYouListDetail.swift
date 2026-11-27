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
    /// "Answer question": the answer is typed, in the Supervisor chat, so
    /// replying there is the decision. It is never sent as an answer.
    let answersInChat: Bool
    /// "Review plan" on a suggestion with a plan: reveals the plan here. It
    /// is not an answer (the hub keeps the question open, and sending it
    /// would hide the card without showing the plan).
    let reviewsPlan: Bool
    let dismiss: SupervisorCardAction

    init(card: SupervisorCard) {
        let hasThread = card.threadKey != nil || !card.threadKeys.isEmpty
        let op = card.primaryAction?.op
        let isCompletion = card.kind == "completed" || op == "open_chat"
        let isExplicitAction = ["merge_ready", "pr_ready", "ci_failed", "preference"].contains(card.kind ?? "")
            || ["merge", "fix_ci", "preference", "set_preference"].contains(op ?? "")
        let dismissAction = SupervisorCardAction(op: "dismiss", label: "Dismiss", value: "dismiss")
        var answersInChat = false
        var reviewsPlan = false

        if isCompletion {
            decisions = []
            dismiss = dismissAction
        } else if card.hasQuestionWalkthrough || DecisionContract.walkthroughOps.contains((op ?? "").lowercased()) {
            // Answered question by question in the walkthrough; "Review N
            // questions" is not an answer and is never sent as one.
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
            let localOptions = card.options.filter { option in
                switch option.lowercased() {
                case "answer question":
                    answersInChat = true
                    return false
                case "review plan" where card.plan != nil:
                    reviewsPlan = true
                    return false
                default:
                    return true
                }
            }
            let options = localOptions
                .filter { !$0.isEmpty && $0.lowercased() != "open thread" && $0.lowercased() != "dismiss" }
                .prefix(4)
                .map { SupervisorCardAction(op: "answer", label: Self.capitalizedFirst($0), value: $0) }
            if !options.isEmpty {
                decisions = Array(options)
            } else if !answersInChat && !reviewsPlan,
                      let primary = card.primaryAction, !primary.label.isEmpty, primary.op != "dismiss" {
                decisions = [primary]
            } else {
                decisions = []
            }
            dismiss = dismissAction
        }
        canReply = card.canReply || hasThread || answersInChat
        self.answersInChat = answersInChat
        self.reviewsPlan = reviewsPlan
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
    /// At accessibility text sizes rows wrap in full instead of clipping.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            statusMark
            VStack(alignment: .leading, spacing: 3) {
                Text(card.headline)
                    .font(.subheadline.weight(isUpdate ? .regular : .semibold))
                    .foregroundStyle(isUpdate ? Theme.muted : Theme.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 3)
                    .multilineTextAlignment(.leading)
                if let reason, !reason.isEmpty {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
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

    @State private var showsPlan = false

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

            if card.hasQuestionWalkthrough {
                questionItems(card, actions: actions)
            } else if let decisionView = card.decisionView {
                contract(card, decisionView, actions: actions)
            } else {
                legacy(card, digest: digest, actions: actions)
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

    /// The decision contract: Goal, Status, Decision and Recommendation,
    /// then the options (each once, the recommended one filled and tagged),
    /// Reply and Dismiss, then evidence links on their own.
    @ViewBuilder
    private func contract(_ card: SupervisorCard, _ decisionView: SupervisorDecisionView, actions: NeedsYouActions) -> some View {
        // Plain answers use the contract's options; a specialized card (PR
        // ready, CI failing, suggestion) keeps the hub's executable actions,
        // while "Answer question" and "Review plan" stay local below.
        let choices = DecisionContract.ownsActions(card)
            ? DecisionContract.choices(for: card)
            : DecisionContract.passthrough(actions.decisions)
        DecisionContractSections(view: decisionView, choices: choices)

        Section {
            ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                DecisionChoiceButton(choice: choice, enabled: !isBusy, fullWidth: true) {
                    onAct(card, choice.action)
                }
                .listRowSeparator(.hidden)
                .accessibilityIdentifier("needs-you-action-\(index)")
            }
            if actions.canReply {
                Button {
                    onReplyInChat(card)
                } label: {
                    Label(choices.isEmpty ? "Answer in Supervisor chat" : "Reply in Supervisor chat",
                          systemImage: "arrowshape.turn.up.left")
                }
                .accessibilityIdentifier("needs-you-reply")
            }
            if actions.reviewsPlan, let plan = card.plan {
                DisclosureGroup(isExpanded: $showsPlan) {
                    planDetails(plan)
                } label: {
                    Text("Review plan")
                }
                .accessibilityIdentifier("needs-you-review-plan")
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
            Text(choices.isEmpty ? "Actions" : "Decide")
        } footer: {
            if isBusy {
                Text("Sending…")
            }
        }

        if !decisionView.evidence.isEmpty {
            Section("Evidence") {
                DecisionEvidenceLinks(evidence: decisionView.evidence)
            }
        }
    }

    /// An ask with several questions: the contract's goal and status, then
    /// every question in full with "Review N questions", then Reply and
    /// Later. There is no group answer button.
    @ViewBuilder
    private func questionItems(_ card: SupervisorCard, actions: NeedsYouActions) -> some View {
        if let decisionView = card.decisionView {
            DecisionContractSections(view: decisionView, choices: [])
        }

        Section {
            QuestionItemsSection(card: card, idPrefix: "needs-you")
        } header: {
            Text("Questions")
                .accessibilityIdentifier("needs-you-questions-header")
        }

        Section {
            if actions.canReply {
                Button {
                    onReplyInChat(card)
                } label: {
                    Label("Reply in Supervisor chat", systemImage: "arrowshape.turn.up.left")
                }
                .accessibilityIdentifier("needs-you-reply")
            }
            let later = card.secondaryAction.flatMap { ["defer", "dismiss"].contains($0.op.lowercased()) && !$0.label.isEmpty ? $0 : nil }
                ?? actions.dismiss
            Button {
                onAct(card, later)
            } label: {
                Text(later.label)
                    .foregroundStyle(Theme.muted)
            }
            .disabled(isBusy)
            .accessibilityIdentifier("needs-you-dismiss")
        } header: {
            Text("Actions")
        }

        if let evidence = card.decisionView?.evidence, !evidence.isEmpty {
            Section("Evidence") {
                DecisionEvidenceLinks(evidence: evidence)
            }
        }
    }

    /// Cards from hubs without the decision contract, unchanged.
    @ViewBuilder
    private func legacy(_ card: SupervisorCard, digest: SupervisorNeedsYouDigest, actions: NeedsYouActions) -> some View {
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
                    Label(actions.answersInChat ? "Answer in Supervisor chat" : "Reply in Supervisor chat",
                          systemImage: "arrowshape.turn.up.left")
                        .fontWeight(actions.answersInChat && actions.decisions.isEmpty ? .semibold : .regular)
                }
                .accessibilityIdentifier("needs-you-reply")
            }
            if actions.reviewsPlan, let plan = card.plan {
                DisclosureGroup(isExpanded: $showsPlan) {
                    planDetails(plan)
                } label: {
                    Text("Review plan")
                }
                .accessibilityIdentifier("needs-you-review-plan")
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

extension NeedsYouDetailView {
    @ViewBuilder
    fileprivate func planDetails(_ plan: SupervisorSuggestionPlan) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label = plan.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
                Text(label)
                    .font(.subheadline.weight(.semibold))
            }
            if let next = plan.nextAction?.trimmingCharacters(in: .whitespacesAndNewlines), !next.isEmpty {
                Text(next)
                    .font(.subheadline)
            }
            if let acceptance = plan.acceptance?.trimmingCharacters(in: .whitespacesAndNewlines), !acceptance.isEmpty {
                Text("Acceptance: \(acceptance)")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
        }
        .textSelection(.enabled)
    }
}

/// Pushes one decision on the Supervisor's navigation stack.
struct NeedsYouRoute: Hashable {
    let cardID: String
}
