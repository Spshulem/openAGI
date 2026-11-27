import SwiftUI

// The decision contract on iPhone (card.decisionView, src/fleet/decision-view.js):
// every decision shows Goal, Status, Decision and Recommendation, in that
// order, before any button. The same pieces render compactly on the Needs
// You deck card and in full on the decision screen and the Thread sheet.
// A section the source did not state reads "Not stated"; nothing is hidden
// or invented. Cards from older hubs carry no decisionView and keep their
// previous rendering.

/// One option the owner can pick, merged from the card's actions (what is
/// sent) and the contract's options (label, consequence, flags).
struct DecisionChoice: Equatable, Identifiable {
    let action: SupervisorCardAction
    let label: String
    let consequence: String?
    let recommended: Bool
    let adminBypass: Bool

    var id: String { "\(action.op):\(DecisionContract.identity(action.value ?? label))" }

    /// What VoiceOver reads after the label, and what UI tests assert on.
    var accessibilityValue: String {
        [recommended ? "Recommended" : nil, adminBypass ? DecisionContract.bypassCaption : nil]
            .compactMap { $0 }
            .joined(separator: ", ")
    }
}

enum DecisionContract {
    static let notStated = "Not stated"
    static let bypassCaption = "Admin bypass — skips required review"

    /// Lowercased, trimmed, without the hub's "(admin bypass)" suffix: how
    /// two spellings of one option are recognised as the same option.
    static func normalized(_ text: String?) -> String {
        cleanLabel(text ?? "").lowercased()
    }

    /// Exact identity of an answer: trimmed, without the "(admin bypass)"
    /// suffix, case kept ("delete Feature" and "delete feature" differ).
    static func identity(_ text: String?) -> String {
        cleanLabel(text ?? "").replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    }

    static func cleanLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: #"\s*\(admin bypass\)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Operations that do more than record an answer (guarded merges, CI
    /// fixes, preferences) or that the app handles locally. A card carrying
    /// one keeps the hub's own buttons and their handlers; the contract
    /// still shows its four sections above them.
    static let executableOps: Set<String> = ["merge", "merge_and_deploy", "fix_ci", "preference", "set_preference", "watch_ci"]
    static let localOptions: Set<String> = ["answer question", "review plan"]
    /// Operations of an ask with several questions: opening the walkthrough
    /// and sending item answers. Never a decision button of their own.
    static let walkthroughOps: Set<String> = ["review_items", "answer_items"]
    static let specializedKinds: Set<String> = ["ready", "merge_ready", "pr_ready", "ci_failed", "preference", "suggestion", "completed"]

    /// Whether the contract's option buttons replace the card's buttons:
    /// only for plain answer decisions. Specialized cards (PR ready, CI
    /// failing, suggestions with "Answer question" / "Review plan",
    /// completions) keep the hub's executable actions untouched.
    static func ownsActions(_ card: SupervisorCard) -> Bool {
        guard card.decisionView != nil else { return false }
        // Several questions in one ask are answered one by one in the
        // walkthrough (QuestionItemsView), never through option buttons.
        if card.questionItems.count >= 2 { return false }
        if [card.primaryAction, card.secondaryAction].compactMap({ $0 }).contains(where: { walkthroughOps.contains($0.op.lowercased()) }) { return false }
        if specializedKinds.contains((card.kind ?? "").lowercased()) { return false }
        let actions = [card.primaryAction, card.secondaryAction].compactMap { $0 } + card.extraActions
        if card.primaryAction?.op.lowercased() == "open_chat" { return false }
        for action in actions {
            if executableOps.contains(action.op.lowercased()) { return false }
            if localOptions.contains(normalized(action.label)) || localOptions.contains(normalized(action.value)) { return false }
        }
        if card.options.contains(where: { localOptions.contains(normalized($0)) }) { return false }
        return true
    }

    /// The hub's own actions as choice buttons, unchanged (operation, value,
    /// handler), for specialized cards on the decision screen.
    static func passthrough(_ actions: [SupervisorCardAction]) -> [DecisionChoice] {
        var seen = Set<String>()
        return actions.compactMap { action in
            let key = "\(action.op.lowercased()):\(identity(action.value ?? action.label))"
            guard !action.label.isEmpty, !walkthroughOps.contains(action.op.lowercased()),
                  seen.insert(key).inserted else { return nil }
            return DecisionChoice(action: action, label: cleanLabel(action.label), consequence: nil,
                                  recommended: action.recommended, adminBypass: action.adminBypass)
        }
    }

    /// The decision's options in the order they are offered: the hub's
    /// recommended option first, every option once. Empty without a
    /// decisionView, or for a specialized card (the caller keeps its
    /// previous buttons).
    static func choices(for card: SupervisorCard) -> [DecisionChoice] {
        guard let view = card.decisionView, ownsActions(card) else { return [] }
        let options = view.decision.options
        let recommendedKey = view.recommendation.unknown ? "" : identity(view.recommendation.option ?? view.recommendation.label)
        func matches(_ option: SupervisorDecisionView.Option, _ action: SupervisorCardAction) -> Bool {
            let keys = [identity(option.value), identity(option.label)]
            return keys.contains(identity(action.value)) || keys.contains(identity(action.label))
        }
        func isRecommendedKey(_ keys: [String]) -> Bool {
            !recommendedKey.isEmpty && keys.contains(recommendedKey)
        }

        var out: [DecisionChoice] = []
        var seen = Set<String>()
        let actions = ([card.primaryAction, card.secondaryAction].compactMap { $0 } + card.extraActions).filter { action in
            let op = action.op.lowercased()
            let value = normalized(action.value)  // case-insensitive only for the fixed words below
            return !action.label.isEmpty
                && !["defer", "dismiss", "open_chat", "reply"].contains(op)
                && !walkthroughOps.contains(op)
                && !["dismiss", "later", "open thread"].contains(value)
        }
        for action in actions {
            let option = options.first { matches($0, action) }
            let label = option?.label ?? cleanLabel(action.label)
            // An operation other than a plain answer is its own choice even
            // when it shares a target (Merge PR / Merge & Deploy on one PR).
            let op = action.op.lowercased()
            let scope = op == "answer" ? "" : "\(op):"
            let keys = [identity(label), identity(action.value), identity(option?.value)]
                .filter { !$0.isEmpty }
                .map { scope + $0 }
            guard !keys.isEmpty, keys.allSatisfy({ !seen.contains($0) }) else { continue }
            seen.formUnion(keys)
            let recommended = action.recommended || option?.recommended == true || isRecommendedKey(keys)
            let bypass = action.adminBypass || option?.adminBypass == true
            out.append(DecisionChoice(
                action: SupervisorCardAction(op: action.op, label: label, value: action.value ?? option?.value,
                                             destructive: action.destructive, recommended: recommended, adminBypass: bypass),
                label: label,
                consequence: clean(option?.consequence),
                recommended: recommended,
                adminBypass: bypass
            ))
        }
        // Options the hub did not turn into a button are still answers.
        for option in options {
            let keys = [identity(option.label), identity(option.value)].filter { !$0.isEmpty }
            guard !keys.isEmpty, keys.allSatisfy({ !seen.contains($0) }) else { continue }
            seen.formUnion(keys)
            let recommended = option.recommended || isRecommendedKey(keys)
            out.append(DecisionChoice(
                action: SupervisorCardAction(op: "answer", label: option.label, value: option.value,
                                             recommended: recommended, adminBypass: option.adminBypass),
                label: option.label,
                consequence: clean(option.consequence),
                recommended: recommended,
                adminBypass: option.adminBypass
            ))
        }
        // Stable: the recommended option leads, the rest keep the hub's order.
        return out.filter(\.recommended) + out.filter { !$0.recommended }
    }

    /// Quick replies that are not a copy of an option and carry no bypass
    /// text. An option is offered once, as its button.
    static func quickReplies(for card: SupervisorCard) -> [String] {
        var taken = Set(card.options.map { normalized($0) })
        for action in [card.primaryAction, card.secondaryAction].compactMap({ $0 }) + card.extraActions {
            taken.insert(normalized(action.label))
            taken.insert(normalized(action.value))
        }
        for option in card.decisionView?.decision.options ?? [] {
            taken.insert(normalized(option.label))
            taken.insert(normalized(option.value))
        }
        let recommendationUnknown = card.decisionView?.recommendation.unknown == true
        var seen = Set<String>()
        return card.suggestedReplies.filter { reply in
            let key = normalized(reply)
            guard !key.isEmpty, !taken.contains(key), seen.insert(key).inserted else { return false }
            if key.contains("bypass") || key.contains("admin rights") { return false }
            // "Proceed with the recommended option" means nothing without one.
            if recommendationUnknown && key.contains("recommend") { return false }
            return true
        }
    }

    /// Display text without raw Markdown tables, emphasis markers or internal
    /// routing ids. File paths stay: a permission prompt's command (e.g.
    /// "rm -rf /tmp/build") is the decision itself. The hub already cleans the contract; this
    /// keeps a stray one off the phone. Nil when nothing readable is left.
    static func clean(_ text: String?) -> String? {
        guard let text else { return nil }
        // Only real table structure is dropped (a row framed by pipes, or a
        // "|---|" separator); shell operators such as "a || b" are kept.
        let lines = text.components(separatedBy: .newlines).filter { line in
            line.range(of: #"^\s*\|.*\|\s*\.?\s*$"#, options: .regularExpression) == nil
                && line.range(of: #"^\s*\|?\s*:?-{3,}"#, options: .regularExpression) == nil
        }
        let cleaned = lines.joined(separator: " ")
            // Emphasis pairs only: "rm -rf **/build" stays as written.
            .replacingOccurrences(of: #"\*\*(?=\S)([^*\n]*?\S)\*\*(?!\*)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"\b(?:paseo|codex|claude):[^\s,;)]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\b(?:srv|wks|fq)_[A-Za-z0-9._-]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    /// The `unknowns` entries for one section, by their "Section:" prefix.
    static func unknowns(_ view: SupervisorDecisionView, in section: Section) -> [String] {
        view.unknowns.filter { entry in
            let prefix = entry.split(separator: ":", maxSplits: 1).first.map { $0.lowercased() } ?? ""
            return section.prefixes.contains(prefix.trimmingCharacters(in: .whitespaces))
        }
    }

    enum Section {
        case goal, status, decision, recommendation

        var title: String {
            switch self {
            case .goal: return "Goal"
            case .status: return "Status"
            case .decision: return "Decision"
            case .recommendation: return "Recommendation"
            }
        }

        fileprivate var prefixes: Set<String> {
            switch self {
            case .goal: return ["goal"]
            case .status: return ["status", "done", "blocked", "unverified", "pr", "prs"]
            case .decision: return ["decision", "options", "option"]
            case .recommendation: return ["recommendation"]
            }
        }
    }
}

// MARK: - Views

/// "Recommended": the one marker the recommended option carries everywhere.
struct DecisionRecommendedTag: View {
    var onFilled = false

    var body: some View {
        Label("Recommended", systemImage: "star.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(onFilled ? Color.white : Theme.live)
    }
}

/// "Admin bypass — skips required review": said plainly, warning-tinted.
struct DecisionBypassCaption: View {
    var body: some View {
        Label(DecisionContract.bypassCaption, systemImage: "exclamationmark.shield.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.caution)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct DecisionNotStated: View {
    var reasons: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(DecisionContract.notStated)
                .font(.footnote.italic())
                .foregroundStyle(Theme.muted)
                .accessibilityIdentifier("decision-not-stated")
            ForEach(reasons, id: \.self) { reason in
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One option as a button. The recommended option is filled and tagged; the
/// rest are outlined. A bypass carries its caption and is never filled
/// unless the hub recommended it. Labels wrap; they are never truncated.
struct DecisionChoiceButton: View {
    let choice: DecisionChoice
    var enabled = true
    var fullWidth = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                Text(choice.label)
                    .font(.subheadline.weight(choice.recommended ? .semibold : .medium))
                    .foregroundStyle(choice.recommended ? Color.white : (enabled ? Theme.ink : Theme.muted))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                // Said once, in the button's accessibility value.
                if choice.recommended {
                    DecisionRecommendedTag(onFilled: true)
                        .accessibilityHidden(true)
                }
                if choice.adminBypass {
                    DecisionBypassCaption()
                        .accessibilityHidden(true)
                        .padding(.horizontal, choice.recommended ? 4 : 0)
                        .background {
                            if choice.recommended {
                                RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color(uiColor: .systemBackground))
                            }
                        }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .frame(maxWidth: fullWidth ? .infinity : nil, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(choice.recommended ? Theme.live.opacity(enabled ? 1 : 0.45) : Color.clear)
            }
            .overlay {
                if !choice.recommended {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder((choice.adminBypass ? Theme.caution : Theme.edge).opacity(enabled ? 0.9 : 0.35), lineWidth: 1)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        // One accessible button: its label is the option, its value carries
        // "Recommended" / "Admin bypass". Wrapping the Button in another
        // element exposed the same option twice to VoiceOver.
        .accessibilityLabel(choice.label)
        .accessibilityValue(choice.accessibilityValue)
    }
}

/// The four sections. `.compact` sits inside the deck card's scrolling body
/// (Status keeps two items plus per-PR facts); `.full` is the whole contract
/// for the decision screen and the Thread sheet.
struct DecisionContractView: View {
    enum Style { case compact, full }

    let view: SupervisorDecisionView
    let choices: [DecisionChoice]
    var style: Style = .full

    private var isCompact: Bool { style == .compact }

    var body: some View {
        VStack(alignment: .leading, spacing: isCompact ? 8 : 14) {
            section(.goal) { DecisionGoalBody(view: view, compact: isCompact) }
            section(.status) { DecisionStatusBody(view: view, compact: isCompact) }
            section(.decision) { DecisionOptionsBody(view: view, choices: choices, compact: isCompact) }
            section(.recommendation) { DecisionRecommendationBody(view: view, choices: choices, compact: isCompact) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("decision-contract")
    }

    private func section<Content: View>(_ section: DecisionContract.Section, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: isCompact ? 2 : 4) {
            Text(isCompact ? section.title.uppercased() : section.title)
                .font(isCompact ? .caption2.weight(.bold) : .footnote.weight(.semibold))
                .foregroundStyle(section == .recommendation ? Theme.live : Theme.muted)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("decision-section-\(section.title.lowercased())")
            content()
        }
    }
}

/// The same four sections as grouped List sections, for the decision screen.
struct DecisionContractSections: View {
    let view: SupervisorDecisionView
    let choices: [DecisionChoice]

    var body: some View {
        Section {
            DecisionGoalBody(view: view, compact: false)
        } header: {
            header(.goal)
        }
        Section {
            DecisionStatusBody(view: view, compact: false)
        } header: {
            header(.status)
        }
        Section {
            DecisionOptionsBody(view: view, choices: choices, compact: false)
        } header: {
            header(.decision)
        }
        Section {
            DecisionRecommendationBody(view: view, choices: choices, compact: false)
        } header: {
            header(.recommendation)
        }
    }

    private func header(_ section: DecisionContract.Section) -> some View {
        Text(section.title)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("decision-section-\(section.title.lowercased())")
    }
}

private struct DecisionGoalBody: View {
    let view: SupervisorDecisionView
    let compact: Bool

    var body: some View {
        let title = DecisionContract.clean(view.goal.title)
        let text = DecisionContract.clean(view.goal.text)
        if view.goal.unknown || (title == nil && text == nil) {
            DecisionNotStated(reasons: compact ? [] : DecisionContract.unknowns(view, in: .goal))
        } else {
            VStack(alignment: .leading, spacing: 2) {
                if let title {
                    Text(title)
                        .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                }
                if let text, text.caseInsensitiveCompare(title ?? "") != .orderedSame {
                    Text(text)
                        .font(compact ? .caption : .subheadline)
                        .foregroundStyle(Theme.ink.opacity(0.9))
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
    }
}

private struct DecisionStatusBody: View {
    let view: SupervisorDecisionView
    let compact: Bool

    private struct Item: Identifiable {
        let id: String
        let kind: String
        let text: String
        let symbol: String
        let color: Color
    }

    private var items: [Item] {
        func make(_ list: [String], kind: String, symbol: String, color: Color) -> [Item] {
            list.compactMap { DecisionContract.clean($0) }.enumerated().map { index, text in
                Item(id: "\(kind)-\(index)", kind: kind, text: text, symbol: symbol, color: color)
            }
        }
        return make(view.status.done, kind: "Done", symbol: "checkmark.circle.fill", color: .green)
            + make(view.status.blocked, kind: "Blocked", symbol: "exclamationmark.octagon.fill", color: Theme.caution)
            + make(view.status.unverified, kind: "Unverified", symbol: "questionmark.circle", color: Theme.muted)
    }

    var body: some View {
        let all = items
        let prs = view.status.prs
        if view.status.unknown && all.isEmpty && prs.isEmpty {
            DecisionNotStated(reasons: compact ? [] : DecisionContract.unknowns(view, in: .status))
        } else {
            let shown = compact ? Array(all.prefix(2)) : all
            VStack(alignment: .leading, spacing: compact ? 3 : 6) {
                ForEach(shown) { item in
                    Label {
                        Text("\(Text(item.kind).fontWeight(.semibold)): \(item.text)")
                            .font(compact ? .caption : .subheadline)
                            .foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: item.symbol)
                            .font(compact ? .caption2 : .footnote)
                            .foregroundStyle(item.color)
                            .accessibilityHidden(true)
                    }
                }
                if compact && all.count > shown.count {
                    Text("+\(all.count - shown.count) more in details")
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                }
                ForEach(prs) { pr in
                    VStack(alignment: .leading, spacing: 3) {
                        Text([pr.ref, DecisionContract.clean(pr.title)].compactMap { $0 }.joined(separator: " "))
                            .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        let facts = pr.facts.compactMap { DecisionContract.clean($0) }
                        if !facts.isEmpty {
                            FlowLayout(spacing: 4) {
                                ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                                    Text(fact)
                                        .font(.caption2)
                                        .foregroundStyle(Theme.ink)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Theme.edge.opacity(0.5), lineWidth: 0.5))
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("decision-pr-\(pr.ref)")
                }
                if !compact {
                    ForEach(DecisionContract.unknowns(view, in: .status), id: \.self) { reason in
                        Text(reason)
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}

private struct DecisionOptionsBody: View {
    let view: SupervisorDecisionView
    let choices: [DecisionChoice]
    let compact: Bool

    var body: some View {
        let question = DecisionContract.clean(view.decision.question)
        // Consequences are listed with the question; the options themselves
        // are offered once, as the buttons below.
        let consequences = choices.filter { $0.consequence != nil || (!compact) }
        if view.decision.unknown && question == nil && choices.isEmpty {
            DecisionNotStated(reasons: compact ? [] : DecisionContract.unknowns(view, in: .decision))
        } else {
            VStack(alignment: .leading, spacing: compact ? 3 : 6) {
                if let question {
                    Text(question)
                        .font(compact ? .caption.weight(.medium) : .subheadline.weight(.medium))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    DecisionNotStated()
                }
                ForEach(consequences) { choice in
                    VStack(alignment: .leading, spacing: 1) {
                        Text("If \(Text(choice.label).fontWeight(.semibold)): \(choice.consequence ?? "consequence not stated")")
                            .font(compact ? .caption : .footnote)
                            .foregroundStyle(choice.consequence == nil ? Theme.muted : Theme.ink.opacity(0.9))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    // Read-only text: inside the deck card's tap-to-open body
                    // it would otherwise be exposed as a second "Merge both"
                    // button next to the real option button.
                    .accessibilityRemoveTraits(.isButton)
                    .accessibilityAddTraits(.isStaticText)
                }
                if !compact && choices.isEmpty {
                    Text("No options were offered. Reply below with your call.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
        }
    }
}

private struct DecisionRecommendationBody: View {
    let view: SupervisorDecisionView
    let choices: [DecisionChoice]
    let compact: Bool

    var body: some View {
        let rec = view.recommendation
        let label = DecisionContract.clean(rec.label)
            ?? choices.first(where: { DecisionContract.identity($0.action.value) == DecisionContract.identity(rec.option) })?.label
            ?? DecisionContract.clean(rec.option)
        let why = DecisionContract.clean(rec.why)
        if rec.unknown || (label == nil && why == nil) {
            DecisionNotStated(reasons: compact ? [] : DecisionContract.unknowns(view, in: .recommendation))
        } else {
            let recommendedChoice = choices.first(where: \.recommended)
            VStack(alignment: .leading, spacing: 3) {
                if let label {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(label)
                            .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        DecisionRecommendedTag()
                    }
                }
                if let why {
                    Text("Why: \(why)")
                        .font(compact ? .caption : .footnote)
                        .foregroundStyle(Theme.ink.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                } else if !compact {
                    Text("Why: \(DecisionContract.notStated)")
                        .font(.footnote.italic())
                        .foregroundStyle(Theme.muted)
                }
                if recommendedChoice?.adminBypass == true {
                    DecisionBypassCaption()
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("decision-recommendation")
        }
    }
}

/// Evidence links, kept apart from the decision. Only https links open.
struct DecisionEvidenceLinks: View {
    let evidence: [SupervisorDecisionView.Evidence]

    var body: some View {
        ForEach(evidence) { item in
            if let url = URL(string: item.url), url.scheme == "https" {
                Link(destination: url) {
                    Label(DecisionContract.clean(item.label) ?? "Evidence", systemImage: "arrow.up.right.square")
                        .font(.subheadline)
                }
            } else {
                Label(DecisionContract.clean(item.label) ?? "Evidence", systemImage: "doc.text")
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            }
        }
    }
}
