import SwiftUI

// A Needs You decision in four parts, before any button: Goal, Status,
// Decision (each option with its consequence), Recommendation. Built from the
// hub card's `decisionView` (src/fleet/decision-view.js). A card without one
// keeps the older brief rendering (NeedsYouSections / the question's body).
//
// Rules this file keeps, on every surface:
// - The recommended option is the one prominent button, with a small
//   "Recommended" label; no option is prominent unless the hub recommends it.
// - An admin bypass carries a warning caption and is never the default.
// - Each option is one button: no second button or quick reply repeats it.
// - Unknown parts read "Not stated", from the hub's own flags.
// - Evidence and the reply field stay apart from the decision; nothing here
//   ever fills the reply field.

/// One answer button: the value goes to the hub exactly as the question
/// offers it; the label is what the owner reads.
struct FleetDecisionButton: Equatable, Identifiable {
  let value: String
  let label: String
  let recommended: Bool
  let adminBypass: Bool
  var id: String { value }
}

/// What one decision card shows: its four parts, its answer buttons, and the
/// quick replies that are not already a button.
struct FleetDecisionPresentation: Equatable {
  let view: FleetDecisionView
  let buttons: [FleetDecisionButton]
  let quickReplies: [String]

  var evidence: [FleetDecisionView.Evidence] { view.evidence.filter { $0.link != nil } }

  /// Nil when the card has no `decisionView` (an older hub): callers keep
  /// today's rendering. A clarification question keeps its own flow.
  /// With a question, buttons are limited to the answers it accepts and
  /// carry its exact option strings.
  static func make(question: FleetQuestion?, card: FleetCardBrief?) -> FleetDecisionPresentation? {
    guard let card, let view = card.decisionView else { return nil }
    if question?.isClarificationQuestion == true { return nil }
    // Specialized cards keep their own buttons and handlers: a guarded merge,
    // merge & deploy, CI fix or preference is not an "answer", and a
    // suggestion's "Answer question" / "Review plan" are handled locally.
    if isSpecialized(card: card, question: question) { return nil }

    let answerActions = card.allActions.filter { action in
      (action.op ?? "answer") == "answer" && !(action.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let recommendedKey = view.recommendation.option.map(normalized)

    var candidates: [FleetDecisionButton] = []
    if !view.decision.options.isEmpty {
      for option in view.decision.options {
        let action = answerActions.first {
          normalized($0.value ?? "") == normalized(option.value) || normalized($0.label ?? "") == normalized(option.label)
        }
        let bypass = option.adminBypass || action?.adminBypass == true
        let recommended = option.recommended || action?.recommended == true || recommendedKey == normalized(option.value)
        candidates.append(FleetDecisionButton(
          value: option.value,
          label: buttonLabel(action?.label ?? option.label, adminBypass: bypass),
          recommended: recommended,
          adminBypass: bypass
        ))
      }
    } else {
      for action in answerActions {
        let value = action.value ?? ""
        let recommended = action.recommended || recommendedKey == normalized(value)
        candidates.append(FleetDecisionButton(
          value: value,
          label: buttonLabel(action.label ?? value, adminBypass: action.adminBypass),
          recommended: recommended,
          adminBypass: action.adminBypass
        ))
      }
    }

    if let question {
      // Only answers the question takes, as it spells them; then any answer
      // it takes that the card did not list, plainly.
      let accepted = question.tappableOptions.filter { $0 != "Answer question" && $0 != "Review plan" }
      candidates = candidates.compactMap { button in
        guard let exact = accepted.first(where: { normalized($0) == normalized(button.value) }) else { return nil }
        return FleetDecisionButton(value: exact, label: button.label, recommended: button.recommended, adminBypass: button.adminBypass)
      }
      for option in accepted where !candidates.contains(where: { normalized($0.value) == normalized(option) }) {
        candidates.append(FleetDecisionButton(value: option, label: question.label(for: option), recommended: false, adminBypass: false))
      }
    }

    let buttons = orderedUnique(candidates)
    return FleetDecisionPresentation(
      view: view,
      buttons: buttons,
      quickReplies: quickReplies(card.suggestedReplies, buttons: buttons, options: view.decision.options)
    )
  }

  /// Recommended first, then the hub's order with any admin bypass last;
  /// one button per option, by value or by label.
  static func orderedUnique(_ candidates: [FleetDecisionButton]) -> [FleetDecisionButton] {
    // Only one button is styled as the recommendation.
    var sawRecommended = false
    let marked = candidates.map { button -> FleetDecisionButton in
      guard button.recommended else { return button }
      defer { sawRecommended = true }
      return sawRecommended
        ? FleetDecisionButton(value: button.value, label: button.label, recommended: false, adminBypass: button.adminBypass)
        : button
    }
    let rest = marked.filter { !$0.recommended }
    let ordered = marked.filter(\.recommended) + rest.filter { !$0.adminBypass } + rest.filter(\.adminBypass)
    var seen = Set<String>()
    var out: [FleetDecisionButton] = []
    for button in ordered {
      let keys = [normalized(button.value), normalized(button.label)]
      if keys.contains(where: { seen.contains($0) }) { continue }
      keys.forEach { seen.insert($0) }
      out.append(button)
    }
    return out
  }

  /// The hub's quick replies minus any that repeat an option (it already
  /// has a button) or offer a bypass, case-insensitively, each once.
  static func quickReplies(_ replies: [String], buttons: [FleetDecisionButton], options: [FleetDecisionView.Option]) -> [String] {
    var taken = Set(buttons.flatMap { [normalized($0.value), normalized($0.label)] })
    options.forEach { taken.insert(normalized($0.value)); taken.insert(normalized($0.label)) }
    var out: [String] = []
    for reply in replies {
      let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
      let key = normalized(text)
      guard !text.isEmpty, !taken.contains(key), !key.contains("bypass") else { continue }
      taken.insert(key)
      out.append(text)
    }
    return out
  }

  static let executableOps: Set<String> = ["merge", "merge_and_deploy", "fix_ci", "preference", "set_preference", "watch_ci", "open_chat"]
  static let specializedKinds: Set<String> = ["ready", "merge_ready", "pr_ready", "ci_failed", "preference", "suggestion", "completed"]
  static let localOptions: Set<String> = ["answer question", "review plan"]

  static func isSpecialized(card: FleetCardBrief, question: FleetQuestion?) -> Bool {
    if specializedKinds.contains((card.kind ?? "").lowercased()) { return true }
    for action in card.allActions {
      if executableOps.contains((action.op ?? "answer").lowercased()) { return true }
      if localOptions.contains(normalized(action.label ?? "")) || localOptions.contains(normalized(action.value ?? "")) { return true }
    }
    if let options = question?.options, options.contains(where: { localOptions.contains(normalized($0)) }) { return true }
    return false
  }

  /// The option's own words. A bypass is labelled by the caption under the
  /// button ("Admin bypass — skips required review"), as on the phone, so a
  /// server-side "(admin bypass)" suffix is not repeated in the label.
  static func buttonLabel(_ label: String, adminBypass: Bool) -> String {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard adminBypass else { return trimmed }
    return trimmed
      .replacingOccurrences(of: #"\s*\(\s*admin bypass\s*\)"#, with: "", options: [.regularExpression, .caseInsensitive])
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Lowercased, single-spaced, without a trailing "(admin bypass)".
  static func normalized(_ text: String) -> String {
    text.lowercased()
      .replacingOccurrences(of: #"\(\s*admin bypass\s*\)"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
  }

  /// Text as the owner reads it: a Markdown table flattened to "a · b"
  /// lines, no bold markers, no internal routing ids or file paths.
  static func displayText(_ raw: String) -> String {
    var lines: [String] = []
    for line in raw.components(separatedBy: .newlines) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.contains("|") && (trimmed.contains("---") || trimmed.filter({ $0 == "|" }).count >= 2) {
        let cleaned = trimmed.replacingOccurrences(of: #":?-{3,}:?"#, with: "", options: .regularExpression)
        let cells = cleaned.split(separator: "|")
          .map { $0.trimmingCharacters(in: .whitespaces) }
          .filter { !$0.isEmpty }
        if !cells.isEmpty { lines.append(cells.joined(separator: " · ")) }
        continue
      }
      lines.append(line)
    }
    return lines.joined(separator: "\n")
      .replacingOccurrences(of: "**", with: "")
      .replacingOccurrences(of: #"\b(?:paseo|codex|conductor|claude):[A-Za-z0-9_.\-]+"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"\b(?:srv|wks|fq)_[A-Za-z0-9_.\-]+"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"(?<![\w:/.])(?:~|/)[\w.\-]+(?:/[\w.\-]+)+"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"\(\s*\)"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

extension FleetQuestion {
  /// This question's four-part decision, or nil to keep the older rendering.
  func decisionPresentation(card: FleetCardBrief?) -> FleetDecisionPresentation? {
    FleetDecisionPresentation.make(question: self, card: card)
  }
}

enum NeedsYouDecisionStyle {
  /// The Needs You card: fewer lines per part.
  case compact
  /// The detail / Thread view: everything, plus the list of unknowns.
  case full
}

/// Goal, Status, Decision, Recommendation, in that order.
struct NeedsYouDecisionSections: View {
  let presentation: FleetDecisionPresentation
  var style: NeedsYouDecisionStyle = .full

  private var view: FleetDecisionView { presentation.view }
  private var isCompact: Bool { style == .compact }
  private var titleFont: Font { isCompact ? .system(size: 10, weight: .semibold) : .caption.weight(.semibold) }
  private var bodyFont: Font { isCompact ? .system(size: 11) : WorkspaceTheme.Typography.secondary }
  private var smallFont: Font { isCompact ? .system(size: 10) : .caption }
  private var listLimit: Int { isCompact ? 2 : .max }

  var body: some View {
    VStack(alignment: .leading, spacing: isCompact ? 6 : WorkspaceTheme.Spacing.x3) {
      section("Goal") { goal }
      section("Status") { status }
      section("Decision") { decision }
      section("Recommendation") { recommendation }
      if !isCompact && !view.unknowns.isEmpty {
        section("Not stated") {
          ForEach(Array(view.unknowns.enumerated()), id: \.offset) { _, item in
            Text(FleetDecisionPresentation.displayText(item))
              .font(smallFont)
              .foregroundStyle(WorkspaceTheme.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .textSelection(.enabled)
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(titleFont)
        .foregroundStyle(WorkspaceTheme.muted)
        .accessibilityAddTraits(.isHeader)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var notStated: some View {
    Text("Not stated")
      .font(bodyFont.italic())
      .foregroundStyle(WorkspaceTheme.muted)
  }

  private func line(_ text: String, weight: Font.Weight = .regular, color: Color = WorkspaceTheme.ink) -> some View {
    Text(FleetDecisionPresentation.displayText(text))
      .font(bodyFont.weight(weight))
      .foregroundStyle(color)
      .lineLimit(isCompact ? 3 : nil)
      .fixedSize(horizontal: false, vertical: true)
  }

  // MARK: Goal

  @ViewBuilder private var goal: some View {
    let title = view.goal.title.map(FleetDecisionPresentation.displayText).flatMap { $0.isEmpty ? nil : $0 }
    let text = view.goal.text.map(FleetDecisionPresentation.displayText).flatMap { $0.isEmpty ? nil : $0 }
    if view.goal.unknown || (title == nil && text == nil) {
      notStated
    } else {
      if let title { line(title, weight: .semibold) }
      if let text, text != title { line(text) }
    }
  }

  // MARK: Status

  @ViewBuilder private var status: some View {
    let s = view.status
    if s.isEmpty {
      notStated
    } else {
      bucket(s.done, symbol: "checkmark.circle", color: WorkspaceTheme.live, label: "Done")
      bucket(s.blocked, symbol: "hand.raised", color: WorkspaceTheme.caution, label: "Blocked")
      bucket(s.unverified, symbol: "questionmark.circle", color: WorkspaceTheme.muted, label: "Unverified")
      ForEach(s.prs) { pr in
        HStack(alignment: .firstTextBaseline, spacing: 5) {
          Image(systemName: "arrow.triangle.pull")
            .font(smallFont)
            .foregroundStyle(WorkspaceTheme.muted)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 1) {
            line([pr.ref, pr.title].compactMap { $0 }.joined(separator: " "), weight: .medium)
            if !pr.facts.isEmpty {
              Text(FleetDecisionPresentation.displayText(pr.facts.joined(separator: " · ")))
                .font(smallFont)
                .foregroundStyle(WorkspaceTheme.muted)
                .lineLimit(isCompact ? 2 : nil)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func bucket(_ items: [String], symbol: String, color: Color, label: String) -> some View {
    ForEach(Array(items.prefix(listLimit).enumerated()), id: \.offset) { _, item in
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        Image(systemName: symbol)
          .font(smallFont)
          .foregroundStyle(color)
          .accessibilityLabel(label)
        line(item)
      }
    }
    if items.count > listLimit {
      Text("+\(items.count - listLimit) more \(label.lowercased())")
        .font(smallFont)
        .foregroundStyle(WorkspaceTheme.muted)
    }
  }

  // MARK: Decision

  @ViewBuilder private var decision: some View {
    let d = view.decision
    if d.unknown && d.question == nil && d.options.isEmpty {
      notStated
    } else {
      if let question = d.question { line(question) }
      ForEach(Array(d.options.enumerated()), id: \.offset) { _, option in
        VStack(alignment: .leading, spacing: 1) {
          HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("•").font(bodyFont).foregroundStyle(WorkspaceTheme.muted)
            line(option.label, weight: .medium)
            if isRecommended(option) { NeedsYouRecommendedTag() }
          }
          Group {
            if option.adminBypass {
              NeedsYouAdminBypassCaption()
            }
            if let consequence = option.consequence, !(option.adminBypass && consequence.lowercased().hasPrefix("admin bypass")) {
              Text(FleetDecisionPresentation.displayText(consequence))
                .font(smallFont)
                .foregroundStyle(WorkspaceTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            } else if option.consequence == nil && !option.adminBypass {
              Text("Consequence: Not stated")
                .font(smallFont.italic())
                .foregroundStyle(WorkspaceTheme.muted)
            }
          }
          .padding(.leading, 12)
        }
      }
      if d.options.isEmpty {
        Text("Options: Not stated")
          .font(smallFont.italic())
          .foregroundStyle(WorkspaceTheme.muted)
      }
    }
  }

  private func isRecommended(_ option: FleetDecisionView.Option) -> Bool {
    if option.recommended { return true }
    guard let key = view.recommendation.option else { return false }
    return FleetDecisionPresentation.normalized(key) == FleetDecisionPresentation.normalized(option.value)
  }

  // MARK: Recommendation

  @ViewBuilder private var recommendation: some View {
    let r = view.recommendation
    let label = r.label ?? r.option
    if r.unknown || (label == nil && r.why == nil) {
      notStated
    } else {
      if let label { line(label, weight: .semibold) }
      if let why = r.why, FleetDecisionPresentation.normalized(why) != FleetDecisionPresentation.normalized(label ?? "") {
        line(why, color: WorkspaceTheme.ink.opacity(0.85))
      }
    }
  }
}

/// The small label under or beside the recommended option.
struct NeedsYouRecommendedTag: View {
  var body: some View {
    Text("Recommended")
      .font(.caption2.weight(.semibold))
      .foregroundStyle(WorkspaceTheme.live)
      .fixedSize()
  }
}

/// The plain warning on an option that merges over a required review.
struct NeedsYouAdminBypassCaption: View {
  var body: some View {
    Label("Admin bypass — skips required review", systemImage: "exclamationmark.triangle.fill")
      .font(.caption2.weight(.medium))
      .foregroundStyle(WorkspaceTheme.caution)
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// The answer buttons, recommended first and prominent, side by side when
/// they fit, else one per line. The caller disables them while busy.
struct NeedsYouDecisionButtons: View {
  let buttons: [FleetDecisionButton]
  let onAnswer: (FleetDecisionButton) -> Void

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .top, spacing: 8) { cells }
      VStack(alignment: .leading, spacing: 6) { cells }
    }
  }

  @ViewBuilder private var cells: some View {
    ForEach(buttons) { button in
      VStack(alignment: .leading, spacing: 2) {
        let hint: String = button.adminBypass ? "Admin bypass: skips required review" : ""
        WorkspaceActionButton(prominent: button.recommended, small: true) {
          onAnswer(button)
        } label: {
          Text(button.label).fixedSize()
        }
        .accessibilityHint(hint)
        if button.recommended { NeedsYouRecommendedTag() }
        if button.adminBypass { NeedsYouAdminBypassCaption() }
      }
    }
  }
}

/// Links that back the decision, in their own section after it.
struct NeedsYouDecisionEvidence: View {
  let evidence: [FleetDecisionView.Evidence]
  var compact = false

  var body: some View {
    if !evidence.isEmpty {
      VStack(alignment: .leading, spacing: 3) {
        Text("Evidence")
          .font(compact ? .system(size: 10, weight: .semibold) : .caption.weight(.semibold))
          .foregroundStyle(WorkspaceTheme.muted)
          .accessibilityAddTraits(.isHeader)
        ForEach(Array(evidence.enumerated()), id: \.offset) { _, item in
          if let url = item.link {
            Link("\(FleetDecisionPresentation.displayText(item.label)) ↗", destination: url)
              .font(compact ? .system(size: 10) : .caption)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// Quick replies that are not an option: each sends as typed, straight away.
/// They never fill the reply field.
struct NeedsYouQuickReplies: View {
  let replies: [String]
  let onSend: (String) -> Void

  var body: some View {
    if !replies.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text("Quick replies")
          .font(.caption.weight(.semibold))
          .foregroundStyle(WorkspaceTheme.muted)
          .accessibilityAddTraits(.isHeader)
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { chips }
          VStack(alignment: .leading, spacing: 4) { chips }
        }
      }
    }
  }

  @ViewBuilder private var chips: some View {
    ForEach(replies, id: \.self) { reply in
      Button(reply) { onSend(reply) }
        .buttonStyle(.borderless)
        .font(.caption)
        .foregroundStyle(WorkspaceTheme.live)
        .help("Send this reply to the agent")
    }
  }
}
