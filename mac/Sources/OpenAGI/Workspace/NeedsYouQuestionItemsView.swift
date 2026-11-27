import SwiftUI

// A Needs You ask with several separate questions: the questions themselves
// (compact on a card, in full in the detail), and a walkthrough that takes
// them one at a time. Logic is in NeedsYouQuestionItems.swift; drafts, the
// walkthrough position and results live on FleetConsumer (the overlay
// resizes from it). Nothing here answers the group as a whole, preselects a
// recommendation, or sends without the owner pressing Send or Retry.

extension FleetQuestionItemBadge {
  var color: Color {
    switch self {
    case .delivered: return WorkspaceTheme.live
    case .queued: return .blue
    case .failed: return WorkspaceTheme.alert
    case .draft: return WorkspaceTheme.caution
    case .notAnswered, .skipForNow, .skipped, .unknown: return WorkspaceTheme.muted
    }
  }
}

struct NeedsYouQuestionItemBadgeView: View {
  let badge: FleetQuestionItemBadge
  var compact = false

  var body: some View {
    Text(badge.text)
      .font(compact ? .system(size: 9, weight: .semibold) : .caption2.weight(.semibold))
      .foregroundStyle(badge.color)
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .background(badge.color.opacity(0.12), in: Capsule())
      .fixedSize()
  }
}

/// "Review N questions": opens the walkthrough. It sends nothing.
struct NeedsYouReviewQuestionsButton: View {
  @ObservedObject var fleet = FleetConsumer.shared
  let question: FleetQuestion
  let card: FleetCardBrief
  /// The overlay first opens the question's detail screen.
  var opensDetail = false

  var body: some View {
    let drafted = FleetQuestionItemsLogic.request(items: card.questionItems, drafts: fleet.itemDrafts[question.id] ?? [:]).itemIds.count
    HStack(spacing: 6) {
      WorkspaceActionButton(prominent: true, small: true) {
        if opensDetail { fleet.openQuestion(question) }
        fleet.startWalkthrough(question)
      } label: {
        Text(FleetQuestionItemsLogic.reviewLabel(card)).fixedSize()
      }
      .help("Go through the questions one at a time. Nothing is sent until you press Send.")
      if drafted > 0 {
        Text("\(drafted) not sent yet")
          .font(.caption2)
          .foregroundStyle(WorkspaceTheme.caution)
          .fixedSize()
      }
    }
  }
}

/// Each question inline: its words, choices or free text, the agent's
/// recommendation (text only), what it unblocks, and where it stands.
struct NeedsYouQuestionList: View {
  @ObservedObject var fleet = FleetConsumer.shared
  let question: FleetQuestion
  let card: FleetCardBrief
  var style: NeedsYouDecisionStyle = .full
  /// Rows shown before "+N more"; nil shows all.
  var maxRows: Int? = nil
  /// Opens the walkthrough at this question.
  var onOpenItem: ((Int) -> Void)? = nil

  private var isCompact: Bool { style == .compact }
  private var titleFont: Font { isCompact ? .system(size: 10.5, weight: .semibold) : .callout.weight(.semibold) }
  private var bodyFont: Font { isCompact ? .system(size: 11) : WorkspaceTheme.Typography.secondary }
  private var smallFont: Font { isCompact ? .system(size: 10) : .caption }

  var body: some View {
    let items = card.questionItems
    let shown = maxRows.map { Array(items.prefix($0)) } ?? items
    VStack(alignment: .leading, spacing: isCompact ? 6 : WorkspaceTheme.Spacing.x3) {
      VStack(alignment: .leading, spacing: 1) {
        Text("Questions")
          .font(isCompact ? .system(size: 10, weight: .semibold) : .caption.weight(.semibold))
          .foregroundStyle(WorkspaceTheme.muted)
          .accessibilityAddTraits(.isHeader)
        Text(FleetQuestionItemsLogic.summaryLine(items))
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      ForEach(Array(shown.enumerated()), id: \.element.itemId) { index, item in
        row(item, index: index)
      }
      if shown.count < items.count {
        Text("+\(items.count - shown.count) more question\(items.count - shown.count == 1 ? "" : "s")")
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func row(_ item: FleetQuestionItem, index: Int) -> some View {
    let draft = fleet.itemDraft(question.id, item.itemId)
    let badge = FleetQuestionItemsLogic.badge(item, draft: draft)
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(FleetDecisionPresentation.displayText(item.title))
          .font(titleFont)
          .foregroundStyle(WorkspaceTheme.ink)
          .lineLimit(isCompact ? 1 : nil)
        Spacer(minLength: 4)
        NeedsYouQuestionItemBadgeView(badge: badge, compact: isCompact)
      }
      Text(FleetDecisionPresentation.displayText(item.question))
        .font(bodyFont)
        .foregroundStyle(WorkspaceTheme.ink)
        .lineLimit(isCompact ? 2 : nil)
        .fixedSize(horizontal: false, vertical: true)
      if !isCompact, let context = item.context, FleetDecisionPresentation.normalized(context) != FleetDecisionPresentation.normalized(item.question) {
        Text(FleetDecisionPresentation.displayText(context))
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      Text(item.choices.isEmpty ? "Free text answer" : "Choices: " + item.choices.joined(separator: " · ") + (item.freeText && !isCompact ? " · or your own words" : ""))
        .font(smallFont)
        .foregroundStyle(WorkspaceTheme.muted)
        .lineLimit(isCompact ? 1 : nil)
      if let rec = item.recommendation {
        Text("Agent recommends: \(FleetDecisionPresentation.displayText(rec))")
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.ink.opacity(0.85))
          .lineLimit(isCompact ? 2 : nil)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let unblocks = item.unblocks {
        Text("Unblocks: \(FleetDecisionPresentation.displayText(unblocks))")
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.muted)
          .lineLimit(isCompact ? 2 : nil)
          .fixedSize(horizontal: false, vertical: true)
      }
      stateLine(item, draft: draft)
      if !isCompact, let onOpenItem, FleetQuestionItemsLogic.isEditable(item) {
        HStack(spacing: 8) {
          Button(draft?.trimmedAnswer == nil ? "Answer" : "Edit") { onOpenItem(index) }
            .buttonStyle(.borderless)
            .font(.caption.weight(.medium))
            .foregroundStyle(WorkspaceTheme.live)
          if item.state.status == .failed {
            NeedsYouQuestionRetryButton(question: question, item: item)
          }
        }
      }
    }
    .padding(isCompact ? 6 : WorkspaceTheme.Spacing.x2)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(WorkspaceTheme.surfaceFill.opacity(isCompact ? 0.45 : 0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  @ViewBuilder
  private func stateLine(_ item: FleetQuestionItem, draft: FleetQuestionItemDraft?) -> some View {
    switch item.state.status {
    case .delivered, .queued:
      if let answer = item.state.answer {
        Text("\(item.state.status == .queued ? "Queued" : "Sent"): \(answer)")
          .font(smallFont.weight(.medium))
          .foregroundStyle(FleetQuestionItemsLogic.badge(item, draft: nil).color)
          .lineLimit(isCompact ? 1 : nil)
      }
    case .failed:
      let kept = FleetQuestionItemsLogic.pendingAnswer(item, draft: draft)
      Text("Not delivered\(item.state.detail.map { " (\($0))" } ?? "")\(kept.map { ". Kept: \($0)" } ?? "")")
        .font(smallFont.weight(.medium))
        .foregroundStyle(WorkspaceTheme.alert)
        .lineLimit(isCompact ? 2 : nil)
        .fixedSize(horizontal: false, vertical: true)
    default:
      if let text = draft?.trimmedAnswer {
        Text("Your draft: \(text)")
          .font(smallFont.weight(.medium))
          .foregroundStyle(WorkspaceTheme.caution)
          .lineLimit(isCompact ? 1 : nil)
      }
    }
  }
}

/// Resends one failed question's kept answer, alone.
struct NeedsYouQuestionRetryButton: View {
  @ObservedObject var fleet = FleetConsumer.shared
  let question: FleetQuestion
  let item: FleetQuestionItem

  var body: some View {
    Button("Retry") {
      Task { await fleet.sendItemAnswers(question, only: [item.itemId]) }
    }
    .buttonStyle(.borderless)
    .font(.caption.weight(.medium))
    .foregroundStyle(WorkspaceTheme.alert)
    .disabled(fleet.itemsInFlight.contains(question.id) || FleetQuestionItemsLogic.pendingAnswer(item, draft: fleet.itemDraft(question.id, item.itemId)) == nil)
    .help("Send this answer again")
  }
}

/// One question at a time: Back / Skip / Next, the choices as buttons (a
/// pick is only a draft), a free-text field, the recommendation as text,
/// progress, and one Send for every drafted answer and skip.
struct NeedsYouQuestionWalkthrough: View {
  @ObservedObject var fleet = FleetConsumer.shared
  let question: FleetQuestion
  let card: FleetCardBrief
  var compact = false

  private var qid: String { question.id }
  private var bodyFont: Font { compact ? .system(size: 11.5) : WorkspaceTheme.Typography.body }
  private var smallFont: Font { compact ? .system(size: 10) : .caption }

  var body: some View {
    let items = card.questionItems
    if items.isEmpty {
      EmptyView()
    } else {
      let index = min(max(fleet.walkthroughs[qid] ?? 0, 0), items.count - 1)
      let item = items[index]
      let draft = fleet.itemDraft(qid, item.itemId)
      let busy = fleet.itemsInFlight.contains(qid)
      VStack(alignment: .leading, spacing: compact ? 6 : WorkspaceTheme.Spacing.x3) {
        header(index: index, total: items.count)
        page(item, draft: draft, busy: busy)
        navigation(item, index: index, total: items.count, busy: busy)
        WorkspaceHairline(leadingInset: 0)
        sendRow(busy: busy)
        if let note = fleet.itemNotes[qid] {
          FleetNoteRow(note: note) { fleet.clearItemNote(qid) }
        }
      }
      .padding(compact ? 8 : WorkspaceTheme.Spacing.x3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(WorkspaceTheme.surfaceFill.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Question \(FleetQuestionItemsLogic.progress(index: index, total: items.count))")
    }
  }

  private func header(index: Int, total: Int) -> some View {
    HStack(spacing: 8) {
      Text(FleetQuestionItemsLogic.progress(index: index, total: total))
        .font(smallFont.weight(.semibold))
        .foregroundStyle(WorkspaceTheme.muted)
        .monospacedDigit()
      ProgressView(value: Double(index + 1), total: Double(max(total, 1)))
        .progressViewStyle(.linear)
        .tint(WorkspaceTheme.live)
        .frame(maxWidth: compact ? 90 : 160)
      Spacer(minLength: 4)
      Button("Close") { fleet.closeWalkthrough(qid) }
        .buttonStyle(.borderless)
        .font(smallFont)
        .help("Close the walkthrough. Drafts are kept.")
    }
  }

  @ViewBuilder
  private func page(_ item: FleetQuestionItem, draft: FleetQuestionItemDraft?, busy: Bool) -> some View {
    let badge = FleetQuestionItemsLogic.badge(item, draft: draft)
    let editable = FleetQuestionItemsLogic.isEditable(item)
    VStack(alignment: .leading, spacing: compact ? 5 : 8) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(FleetDecisionPresentation.displayText(item.title))
          .font(compact ? .system(size: 11, weight: .semibold) : .callout.weight(.semibold))
          .foregroundStyle(WorkspaceTheme.muted)
        Spacer(minLength: 4)
        NeedsYouQuestionItemBadgeView(badge: badge, compact: compact)
      }
      Text(FleetDecisionPresentation.displayText(item.question))
        .font(bodyFont.weight(.medium))
        .foregroundStyle(WorkspaceTheme.ink)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      if let context = item.context, FleetDecisionPresentation.normalized(context) != FleetDecisionPresentation.normalized(item.question) {
        Text(FleetDecisionPresentation.displayText(context))
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let rec = item.recommendation {
        // Text only: never preselected and never sent for the owner.
        VStack(alignment: .leading, spacing: 1) {
          Text("Agent's recommendation")
            .font(smallFont.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.muted)
          Text(FleetDecisionPresentation.displayText(rec))
            .font(smallFont)
            .foregroundStyle(WorkspaceTheme.ink.opacity(0.85))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let unblocks = item.unblocks {
        Text("Unblocks: \(FleetDecisionPresentation.displayText(unblocks))")
          .font(smallFont)
          .foregroundStyle(WorkspaceTheme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      if editable {
        answerEditor(item, draft: draft, busy: busy)
      } else {
        readOnly(item)
      }
    }
  }

  @ViewBuilder
  private func answerEditor(_ item: FleetQuestionItem, draft: FleetQuestionItemDraft?, busy: Bool) -> some View {
    let pending = FleetQuestionItemsLogic.pendingAnswer(item, draft: draft)
    if item.state.status == .failed {
      HStack(spacing: 6) {
        Text("Not delivered\(item.state.detail.map { " (\($0))" } ?? ""). Your answer is kept.")
          .font(smallFont.weight(.medium))
          .foregroundStyle(WorkspaceTheme.alert)
          .fixedSize(horizontal: false, vertical: true)
        NeedsYouQuestionRetryButton(question: question, item: item)
      }
    } else if item.state.status == .skipped && draft?.trimmedAnswer == nil {
      Text("You skipped this for now. Answer it now, or leave it open.")
        .font(smallFont)
        .foregroundStyle(WorkspaceTheme.muted)
    }
    if !item.choices.isEmpty {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 6) { choiceButtons(item, pending: pending) }
        VStack(alignment: .leading, spacing: 5) { choiceButtons(item, pending: pending) }
      }
      .disabled(busy)
    }
    if item.freeText {
      // A TextEditor in a fixed frame, not a growing TextField: every line of
      // a long answer stays reachable and the panel keeps its height.
      let text = Binding(
        get: { fleet.itemDraft(qid, item.itemId)?.answer ?? (item.state.status == .failed ? (item.state.answer ?? "") : "") },
        set: { fleet.setItemAnswer($0, questionId: qid, itemId: item.itemId) }
      )
      TextEditor(text: text)
        .font(compact ? .system(size: 11) : .body)
        .scrollContentBackground(.hidden)
        .padding(4)
        .frame(height: compact ? 48 : 64)
        .background(WorkspaceTheme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(WorkspaceTheme.edge, lineWidth: 1))
        .overlay(alignment: .topLeading) {
          if text.wrappedValue.isEmpty {
            Text(item.choices.isEmpty ? "Type your answer" : "Or type your own answer")
              .font(compact ? .system(size: 11) : .body)
              .foregroundStyle(WorkspaceTheme.muted)
              .padding(.horizontal, 9)
              .padding(.vertical, 4)
              .allowsHitTesting(false)
          }
        }
        .accessibilityLabel(item.choices.isEmpty ? "Your answer" : "Your own answer")
        .disabled(busy)
    }
    if draft?.trimmedAnswer != nil || draft?.skipped == true {
      Button(draft?.skipped == true ? "Undo skip" : "Clear answer") {
        fleet.clearItemDraft(questionId: qid, itemId: item.itemId)
      }
      .buttonStyle(.borderless)
      .font(smallFont)
      .foregroundStyle(WorkspaceTheme.muted)
      .disabled(busy)
    }
  }

  @ViewBuilder
  private func choiceButtons(_ item: FleetQuestionItem, pending: String?) -> some View {
    ForEach(item.choices, id: \.self) { choice in
      let selected = pending.map { FleetDecisionPresentation.identity($0) == FleetDecisionPresentation.identity(choice) } ?? false
      VStack(alignment: .leading, spacing: 2) {
        WorkspaceActionButton(prominent: selected, small: true) {
          // A pick is a draft: nothing is sent until Send.
          fleet.setItemAnswer(selected ? nil : choice, questionId: qid, itemId: item.itemId)
        } label: {
          Label(choice, systemImage: selected ? "checkmark.circle.fill" : "circle")
            .fixedSize()
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        // Only a recommendation that names this exact choice tags it.
        if item.recommendedChoice == choice { NeedsYouRecommendedTag() }
      }
    }
  }

  @ViewBuilder
  private func readOnly(_ item: FleetQuestionItem) -> some View {
    switch item.state.status {
    case .delivered:
      Text("Delivered: \(item.state.answer ?? "answer sent")")
        .font(smallFont.weight(.medium))
        .foregroundStyle(WorkspaceTheme.live)
        .fixedSize(horizontal: false, vertical: true)
    case .queued:
      Text("Queued: \(item.state.answer ?? "answer saved"). It goes to the agent once the Mac can type.")
        .font(smallFont.weight(.medium))
        .foregroundStyle(Color.blue)
        .fixedSize(horizontal: false, vertical: true)
    default:
      Text("This build can't read this question's state. Answer it in the agent's chat if it is still open.")
        .font(smallFont)
        .foregroundStyle(WorkspaceTheme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func navigation(_ item: FleetQuestionItem, index: Int, total: Int, busy: Bool) -> some View {
    HStack(spacing: 8) {
      WorkspaceActionButton(small: true) {
        fleet.moveWalkthrough(qid, to: index - 1)
      } label: {
        Label("Back", systemImage: "chevron.left")
      }
      .disabled(index == 0)
      if FleetQuestionItemsLogic.isEditable(item) {
        WorkspaceActionButton(small: true) {
          fleet.skipItem(questionId: qid, itemId: item.itemId)
          if index < total - 1 { fleet.moveWalkthrough(qid, to: index + 1) }
        } label: {
          Text("Skip for now")
        }
        .disabled(busy)
        .help("Leave this question open and go on")
      }
      Spacer(minLength: 4)
      WorkspaceActionButton(small: true) {
        fleet.moveWalkthrough(qid, to: index + 1)
      } label: {
        Label("Next", systemImage: "chevron.right")
      }
      .disabled(index >= total - 1)
    }
  }

  private func sendRow(busy: Bool) -> some View {
    let request = fleet.pendingItemsRequest(for: question)
    return HStack(spacing: 8) {
      WorkspaceActionButton(prominent: true, small: true) {
        Task { await fleet.sendItemAnswers(question) }
      } label: {
        Text(FleetQuestionItemsLogic.sendLabel(request)).fixedSize()
      }
      .disabled(busy || request.isEmpty)
      .help("Send only the answers you picked or typed. Questions you haven't answered stay open.")
      if busy { ProgressView().controlSize(.small) }
      Spacer(minLength: 0)
      Text(request.isEmpty ? "Nothing to send yet" : "Unanswered questions stay open")
        .font(smallFont)
        .foregroundStyle(WorkspaceTheme.muted)
        .lineLimit(1)
    }
  }
}
