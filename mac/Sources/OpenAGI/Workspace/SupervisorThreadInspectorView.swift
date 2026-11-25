import AppKit
import SupervisorChannelsKit
import SwiftUI

enum WorkspaceInspectorSelection: Equatable, Hashable {
  case question(String)
  case session(String)
  case task(String)
  case activity(String)
}

struct WorkspaceActorPill: View {
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
    .padding(.vertical, 2)
    .background(
      (isOwner ? WorkspaceTheme.live : Color.accentColor).opacity(0.12),
      in: Capsule()
    )
    .foregroundStyle(isOwner ? WorkspaceTheme.live : Color.accentColor)
  }
}

struct WorkspaceMilestoneStrip: View {
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
            .background(tint(for: item.kind).opacity(0.11), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(tint(for: item.kind).opacity(0.24), lineWidth: 0.5)
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
    case .decision, .progress: return WorkspaceTheme.live
    case .question, .blocked: return WorkspaceTheme.caution
    case .pr: return .blue
    case .commit: return WorkspaceTheme.muted
    }
  }
}

struct WorkspaceLabelChipsRow: View {
  let labels: [SupervisorBoardLabel]
  @Binding var activeFilters: Set<String>

  var body: some View {
    if !labels.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 5) {
          ForEach(labels) { item in
            let isSelected = activeFilters.contains(item.raw.lowercased())
            Button {
              let key = item.raw.lowercased()
              if isSelected {
                activeFilters.remove(key)
              } else {
                activeFilters.insert(key)
              }
            } label: {
              HStack(spacing: 2) {
                Text(item.key)
                  .foregroundStyle(isSelected ? .white.opacity(0.85) : WorkspaceTheme.muted)
                Text("=")
                  .foregroundStyle(isSelected ? .white.opacity(0.65) : WorkspaceTheme.muted.opacity(0.7))
                Text(item.value)
                  .fontWeight(.semibold)
              }
              .font(.caption2.monospaced())
              .padding(.horizontal, 7)
              .padding(.vertical, 3)
              .background(
                isSelected ? WorkspaceTheme.live : WorkspaceTheme.surfaceFill,
                in: Capsule()
              )
              .foregroundStyle(isSelected ? Color.white : WorkspaceTheme.ink)
            }
            .buttonStyle(.plain)
            .help(isSelected ? "Clear filter \(item.raw)" : "Filter by \(item.raw)")
          }
        }
      }
    }
  }
}

struct WorkspaceQuietCheckPill: View {
  let label: String

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "clock")
        .font(.system(size: 9, weight: .semibold))
      Text(label)
        .font(.caption2.weight(.medium))
        .lineLimit(1)
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(WorkspaceTheme.surfaceFill, in: Capsule())
    .foregroundStyle(WorkspaceTheme.muted)
  }
}

struct WorkspaceBlockingPill: View {
  let summary: String

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 9, weight: .semibold))
      Text(summary)
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(WorkspaceTheme.caution.opacity(0.14), in: Capsule())
    .foregroundStyle(WorkspaceTheme.caution)
  }
}

struct SupervisorThreadInspectorView: View {
  let selection: WorkspaceInspectorSelection
  @ObservedObject var fleet: FleetConsumer
  @ObservedObject var supervisor: SharedSupervisorClient
  @Binding var activeLabelFilters: Set<String>
  let canStepBackward: Bool
  let canStepForward: Bool
  let onStep: (Int) -> Void
  let onClose: () -> Void
  let onOpenQuestionInChat: (FleetQuestion) -> Void
  let onClaimTask: (MacTaskItem) -> Void
  let onPromoteSessionToTask: (FleetThread) -> Void

  @State private var draftText = ""
  @State private var attachedImages: [WorkspaceImageAttachment] = []
  @State private var queuedReplies: [QueuedSupervisorMessage] = []
  @State private var isSending = false
  @State private var replyFeedback: FleetNote? = nil
  @State private var showAttachMenu = false
  @State private var showConversation = false
  @State private var showPlanDetails = false
  @FocusState private var replyFocused: Bool

  private var resolvedQuestion: FleetQuestion? {
    guard case let .question(id) = selection else { return nil }
    return fleet.question(id)
  }

  private var resolvedTask: MacTaskItem? {
    if case let .task(id) = selection {
      return supervisor.allTasks.first { $0.id == id } ?? supervisor.tasks.first { $0.id == id }
    }
    if let key = directThreadKey {
      return supervisor.tasks.first { $0.sourceMeta?.threadKey == key }
        ?? supervisor.allTasks.first { $0.sourceMeta?.threadKey == key }
    }
    return nil
  }

  private var resolvedActivity: FleetActivityEvent? {
    guard case let .activity(id) = selection else { return nil }
    return fleet.activityEvents.first { $0.id == id }
  }

  private var directThreadKey: String? {
    switch selection {
    case let .question(id):
      return fleet.question(id)?.threadKey
    case let .session(key):
      return key
    case let .task(id):
      return supervisor.allTasks.first(where: { $0.id == id })?.sourceMeta?.threadKey
        ?? supervisor.tasks.first(where: { $0.id == id })?.sourceMeta?.threadKey
    case let .activity(id):
      return fleet.activityEvents.first(where: { $0.id == id })?.threadKey
    }
  }

  private var resolvedThread: FleetThread? {
    directThreadKey.flatMap { fleet.thread($0) }
  }

  private var resolvedDetail: FleetThreadDetail? {
    directThreadKey.flatMap { fleet.details[$0] }
  }

  private var selectionTitle: String {
    if let q = resolvedQuestion { return q.title }
    if let t = resolvedTask { return t.title }
    if let ev = resolvedActivity { return ev.title }
    if let tr = resolvedThread { return tr.name }
    if let dt = resolvedDetail, let t = dt.title, !t.isEmpty { return t }
    return directThreadKey ?? "Inspector"
  }

  private var inspectorKindBadge: String {
    switch selection {
    case .question:
      if let q = resolvedQuestion, !SupervisorAttentionCounting.isActionable(needsYou: q.needsYou) {
        return "Update · no decision needed"
      }
      return "Needs your decision"
    case .session: return "Coding Session"
    case .task: return "Board Task"
    case .activity: return "Activity Event"
    }
  }

  private var actorText: String? {
    resolvedQuestion?.actorLabel
      ?? resolvedThread?.actorLabel
      ?? resolvedTask?.sourceMeta?.actor
      ?? resolvedActivity?.actor
  }

  private var rawLabels: [String] {
    var combined: [String] = []
    if let q = resolvedQuestion { combined.append(contentsOf: q.labels) }
    if let t = resolvedThread { combined.append(contentsOf: t.labels) }
    if let tk = resolvedTask?.tags { combined.append(contentsOf: tk) }
    if let ev = resolvedActivity { combined.append(contentsOf: ev.labels) }
    return combined
  }

  private var openChat: FleetOpenChat? {
    resolvedQuestion?.openChat
      ?? resolvedQuestion?.chats.first
      ?? resolvedThread?.openChat
      ?? resolvedDetail?.openChat
  }

  /// A question the inspector's reply field can answer. A clarification is
  /// answered here even without a linked thread: sendWorkspaceQuestionReply
  /// routes it through answerClarification.
  static func acceptsReply(_ q: FleetQuestion) -> Bool {
    q.canReply || q.isClarificationQuestion
  }

  private var canComposeReply: Bool {
    if let q = resolvedQuestion {
      return Self.acceptsReply(q)
    }
    return directThreadKey != nil
  }

  var body: some View {
    VStack(spacing: 0) {
      headerBar
      WorkspaceHairline(leadingInset: 0)
      if let q = resolvedQuestion {
        questionDetail(q)
      } else {
        rootStateStrip
        WorkspaceHairline(leadingInset: 0)
        transcriptBody
      }
      if canComposeReply {
        WorkspaceHairline(leadingInset: 0)
        bottomReplyDock
      }
    }
    .background(WorkspaceTheme.canvas)
    .task(id: directThreadKey ?? "") {
      if let tk = directThreadKey, !tk.isEmpty {
        await fleet.loadDetail(tk)
      }
    }
    .onChange(of: selection) { _, _ in
      showConversation = false
      showPlanDetails = false
    }
  }

  // MARK: - Needs You decision

  /// One decision, top to bottom: what it is, the goal, where it stands, why
  /// it needs you, the decision and the recommendation, the actions, then
  /// evidence and (on request) the plan and the conversation.
  private func questionDetail(_ q: FleetQuestion) -> some View {
    let card = fleet.cardBriefs[q.id]
    let digest = q.needsYouDigest(card: card)
    let badge = q.needsYouBadge(card: card)
    return ScrollView {
      VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x4) {
        VStack(alignment: .leading, spacing: 6) {
          if let badge {
            Text(badge.text)
              .font(.caption.weight(.medium))
              .foregroundStyle(badge.tone.color)
              .padding(.horizontal, 6)
              .padding(.vertical, 1)
              .background(badge.tone.color.opacity(0.12), in: Capsule())
          }
          Text(digest.title)
            .font(WorkspaceTheme.Typography.headline)
            .foregroundStyle(WorkspaceTheme.ink)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          if let meta = questionMeta(q) {
            Text(meta)
              .font(.caption)
              .foregroundStyle(WorkspaceTheme.muted)
              .lineLimit(2)
          }
          if q.blockingCount > 0 {
            WorkspaceBlockingPill(
              summary: q.blockingSummary ?? "Blocking \(q.blockingCount) downstream task\(q.blockingCount == 1 ? "" : "s")"
            )
          }
        }

        NeedsYouSections(digest: digest, kinds: [.goal, .state, .blocker])
        NeedsYouSections(digest: digest, kinds: [.decision, .recommendation])

        if !q.remainingItemIds.isEmpty {
          Text("More owner questions remain; answer this one before the next is presented.")
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.muted)
        }
        if let answered = q.clarificationAnswer?.trimmingCharacters(in: .whitespacesAndNewlines), !answered.isEmpty {
          Text("Your answer: \(answered)")
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.muted)
        }

        actionStrip
        if let note = fleet.notes[q.id] {
          FleetNoteRow(note: note) { fleet.clearNote(q.id) }
        }

        if let plan = q.plan, planHasDetails(plan) {
          DisclosureGroup(isExpanded: $showPlanDetails) {
            planDetails(plan)
              .padding(.top, 4)
          } label: {
            Text(plan.label ?? "Plan details")
              .font(.caption.weight(.semibold))
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }

        NeedsYouSections(digest: digest, kinds: [.evidence])
        if let url = card?.prUrl.flatMap({ URL(string: $0) }) {
          Link("Open pull request ↗", destination: url)
            .font(.caption)
        }

        let parsedLabels = SupervisorBoardLabel.extract(from: rawLabels)
        if !parsedLabels.isEmpty {
          WorkspaceLabelChipsRow(labels: parsedLabels, activeFilters: $activeLabelFilters)
        }

        if directThreadKey != nil {
          DisclosureGroup(isExpanded: $showConversation) {
            VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
              threadMessages
            }
            .padding(.top, 4)
          } label: {
            Text(conversationLabel)
              .font(.caption.weight(.semibold))
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
      }
      .padding(WorkspaceTheme.Spacing.x4)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// "#atlas /Checkout · atlas · Checkout (Codex) · asked 3h ago".
  private func questionMeta(_ q: FleetQuestion) -> String? {
    var parts: [String] = []
    if let project = q.project?.trimmingCharacters(in: .whitespacesAndNewlines), !project.isEmpty {
      parts.append("#\(project)")
    }
    if let label = q.chatLabel ?? openChat?.label, !label.isEmpty { parts.append(label) }
    if let actor = actorText, !actor.isEmpty { parts.append(actor) }
    if let at = q.askedTime.flatMap(FleetWatching.parseDate) {
      parts.append("asked \(FleetThreadSummary.ago(at, now: Date()))")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private var conversationLabel: String {
    if let count = resolvedDetail?.conversation?.messages.count, count > 0 {
      return "Conversation · \(count) message\(count == 1 ? "" : "s")"
    }
    return "Conversation"
  }

  private func planHasDetails(_ plan: FleetSuggestionPlan) -> Bool {
    let parts = [plan.acceptance, plan.issueDraft?.title, plan.issueDraft?.body]
    return parts.contains { !($0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
  }

  private func planDetails(_ plan: FleetSuggestionPlan) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if let acceptance = plan.acceptance?.trimmingCharacters(in: .whitespacesAndNewlines), !acceptance.isEmpty {
        Text("Acceptance: \(acceptance)")
          .font(.caption)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      if let issueTitle = plan.issueDraft?.title?.trimmingCharacters(in: .whitespacesAndNewlines), !issueTitle.isEmpty {
        Text("Issue: \(issueTitle)")
          .font(.caption.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
      }
      if let issueBody = plan.issueDraft?.body?.trimmingCharacters(in: .whitespacesAndNewlines), !issueBody.isEmpty {
        WorkspaceMarkdownContent(
          blocks: WorkspaceMarkdownParser.parse(issueBody),
          bodyFont: WorkspaceTheme.Typography.caption,
          textColor: WorkspaceTheme.muted
        )
      }
    }
    .textSelection(.enabled)
  }

  private var headerBar: some View {
    HStack(spacing: 8) {
      Text(inspectorKindBadge)
        .font(.caption.weight(.semibold))
        .foregroundStyle(WorkspaceTheme.muted)

      Spacer()

      HStack(spacing: 2) {
        Button {
          onStep(-1)
        } label: {
          Image(systemName: "chevron.up")
            .frame(width: 24, height: 24)
        }
        .buttonStyle(.borderless)
        .disabled(!canStepBackward)
        .help("Previous item")

        Button {
          onStep(1)
        } label: {
          Image(systemName: "chevron.down")
            .frame(width: 24, height: 24)
        }
        .buttonStyle(.borderless)
        .disabled(!canStepForward)
        .help("Next item")
      }

      if let chat = openChat, let btnTitle = FleetChatOpener.buttonTitle(chat) {
        WorkspaceActionButton(small: true) {
          fleet.openChat(chat)
        } label: {
          Text("\(btnTitle) ↗")
        }
      }

      Button {
        onClose()
      } label: {
        Image(systemName: "xmark")
          .font(.caption.weight(.semibold))
          .foregroundStyle(WorkspaceTheme.muted)
          .frame(width: 24, height: 24)
      }
      .buttonStyle(.borderless)
      .help("Close Thread Inspector")
    }
    .padding(.horizontal, WorkspaceTheme.Spacing.x4)
    .padding(.vertical, WorkspaceTheme.Spacing.x2)
    .background(WorkspaceTheme.surface)
  }

  private var rootStateStrip: some View {
    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
      Text(selectionTitle)
        .font(WorkspaceTheme.Typography.headline)
        .foregroundStyle(WorkspaceTheme.ink)
        .textSelection(.enabled)

      HStack(spacing: 6) {
        if let actorText, !actorText.isEmpty {
          WorkspaceActorPill(actor: actorText)
        }

        if let tr = resolvedThread,
           let nextLabel = SupervisorQuietCheckFormatter.badge(nextCheckISO: tr.nextCheckAt ?? fleet.nextTickAt) {
          WorkspaceQuietCheckPill(label: nextLabel)
        } else if let nextLabel = SupervisorQuietCheckFormatter.badge(nextCheckISO: fleet.nextTickAt), resolvedQuestion != nil {
          WorkspaceQuietCheckPill(label: nextLabel)
        }

        if let task = resolvedTask {
          let state = SupervisorBoardTaskClassifier.classify(
            status: task.status,
            queue: task.queue,
            hasUnmetDeps: false,
            hasOpenQuestion: resolvedQuestion != nil,
            leaseExpiresAtISO: task.sourceMeta?.agentLease?.expiresAt
          )
          let leaseText = SupervisorBoardTaskClassifier.leaseBadgeText(expiresAtISO: task.sourceMeta?.agentLease?.expiresAt)
          Text(leaseText ?? state.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(stateTint(state).opacity(0.14), in: Capsule())
            .foregroundStyle(stateTint(state))
        }
      }

      if let q = resolvedQuestion, q.blockingCount > 0 {
        WorkspaceBlockingPill(
          summary: q.blockingSummary ?? "Blocking \(q.blockingCount) downstream task\(q.blockingCount == 1 ? "" : "s")"
        )
      } else if let blocked = resolvedTask?.sourceMeta?.blockedReason, !blocked.isEmpty {
        WorkspaceBlockingPill(summary: blocked)
      }

      let parsedLabels = SupervisorBoardLabel.extract(from: rawLabels)
      WorkspaceLabelChipsRow(labels: parsedLabels, activeFilters: $activeLabelFilters)

      actionStrip
    }
    .padding(WorkspaceTheme.Spacing.x4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(WorkspaceTheme.surface.opacity(0.65))
  }

  @ViewBuilder
  private var actionStrip: some View {
    if let q = resolvedQuestion {
      let busy = fleet.inFlight.contains(q.id) || fleet.stillSending.contains(q.id)
      VStack(alignment: .leading, spacing: 8) {
        // The agent's options side by side when they fit the inspector,
        // else one per line: never truncated.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { optionButtons(q, busy: busy) }
          VStack(alignment: .leading, spacing: 6) { optionButtons(q, busy: busy) }
        }
        HStack(spacing: 6) {
          Button("Ask Supervisor") {
            onOpenQuestionInChat(q)
          }
          .buttonStyle(.borderless)
          .font(.caption.weight(.medium))
          .foregroundStyle(WorkspaceTheme.live)

          Spacer(minLength: 0)
          Button("Dismiss") {
            Task { await fleet.dismiss(q) }
          }
          .buttonStyle(.borderless)
          .font(.caption)
          .foregroundStyle(WorkspaceTheme.muted)
          .disabled(busy)
        }
      }
    } else if let task = resolvedTask {
      HStack(spacing: 8) {
        if task.sourceMeta?.threadKey == nil && !["completed", "cancelled"].contains(task.status.lowercased()) {
          WorkspaceActionButton(prominent: true, small: true) {
            onClaimTask(task)
          } label: {
            Label("Claim in Paseo", systemImage: "bolt.fill")
          }
        }
        if !["completed", "cancelled", "done"].contains(task.status.lowercased()) {
          WorkspaceActionButton(small: true) {
            Task { await supervisor.completeTask(task.id) }
          } label: {
            Label("Complete", systemImage: "checkmark")
          }
        }
        if let desc = task.description ?? task.notes, !desc.isEmpty {
          Text(desc)
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.muted)
            .lineLimit(1)
        }
      }
    } else if let tr = resolvedThread {
      let busy = fleet.threadInFlight.contains(tr.key)
      HStack(spacing: 8) {
        if tr.watch?.group == "push", tr.muted == nil, tr.pushPreview != nil {
          WorkspaceActionButton(prominent: true, small: true) {
            Task { await fleet.pushNow(tr.key) }
          } label: {
            Text("Push now")
          }
          .disabled(busy || tr.pushing)
        }
        WorkspaceActionButton(small: true) {
          Task {
            if tr.muted != nil {
              await fleet.unmute(tr.key)
            } else {
              await fleet.mute(tr.key)
            }
          }
        } label: {
          Text(tr.muted != nil ? "Unmute" : "Mute 24h")
        }
        .disabled(busy)

        WorkspaceActionButton(small: true) {
          onPromoteSessionToTask(tr)
        } label: {
          Label("Link Task", systemImage: "checklist")
        }
      }
    }
  }

  @ViewBuilder
  private func optionButtons(_ q: FleetQuestion, busy: Bool) -> some View {
    ForEach(Array(q.tappableOptions.prefix(4).enumerated()), id: \.offset) { idx, opt in
      let handlesLocally = opt == "Answer question" || (opt == "Review plan" && q.plan != nil)
      WorkspaceActionButton(prominent: idx == 0 && !q.risky, small: true) {
        if opt == "Answer question" {
          replyFocused = true
        } else if opt == "Review plan", q.plan != nil {
          showPlanDetails.toggle()
        } else {
          Task { await fleet.answer(q, option: opt) }
        }
      } label: {
        Text(q.label(for: opt))
          .fixedSize()
      }
      .disabled(busy && !handlesLocally)
    }
  }

  private static func sanitizeTranscriptText(_ raw: String) -> String {
    raw
      .replacingOccurrences(
        of: #"<oai-mem-citation\b[\s\S]*?(?:</oai-mem-citation>|$)"#,
        with: "",
        options: [.regularExpression, .caseInsensitive]
      )
      .replacingOccurrences(
        of: #"<(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)\b[\s\S]*?(?:</(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)>|$)"#,
        with: "",
        options: [.regularExpression, .caseInsensitive]
      )
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func dedupedMessages(_ list: [FleetConversationMessage]) -> [FleetConversationMessage] {
    var out: [FleetConversationMessage] = []
    var prevNorm: String? = nil
    var prevOwner: Bool? = nil
    for msg in list {
      let cleaned = sanitizeTranscriptText(msg.text)
      guard !cleaned.isEmpty else { continue }
      let norm = cleaned.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      if prevOwner == msg.isOwner, prevNorm == norm {
        continue
      }
      prevOwner = msg.isOwner
      prevNorm = norm
      out.append(msg)
    }
    return Array(out.suffix(40))
  }

  private var transcriptBody: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
          if let q = resolvedQuestion, !q.body.isEmpty {
            WorkspaceMarkdownContent(
              blocks: WorkspaceMarkdownParser.parse(Self.sanitizeTranscriptText(q.body)),
              bodyFont: WorkspaceTheme.Typography.secondary,
              textColor: WorkspaceTheme.ink
            )
            .padding(WorkspaceTheme.Spacing.x3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .workspaceCardSurface(cornerRadius: 12)
          } else if let ev = resolvedActivity, let detail = ev.detail, !detail.isEmpty {
            WorkspaceMarkdownContent(
              blocks: WorkspaceMarkdownParser.parse(Self.sanitizeTranscriptText(detail)),
              bodyFont: WorkspaceTheme.Typography.secondary,
              textColor: WorkspaceTheme.ink
            )
            .padding(WorkspaceTheme.Spacing.x3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .workspaceCardSurface(cornerRadius: 12)
          } else if let task = resolvedTask, let desc = task.description ?? task.notes, !desc.isEmpty {
            WorkspaceMarkdownContent(
              blocks: WorkspaceMarkdownParser.parse(desc),
              bodyFont: WorkspaceTheme.Typography.secondary,
              textColor: WorkspaceTheme.ink
            )
            .padding(WorkspaceTheme.Spacing.x3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .workspaceCardSurface(cornerRadius: 12)
          }

          threadMessages
          Color.clear.frame(height: 1).id("inspector-transcript-bottom")
        }
        .padding(WorkspaceTheme.Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .onAppear {
        proxy.scrollTo("inspector-transcript-bottom", anchor: .bottom)
      }
      .onChange(of: directThreadKey) { _, _ in
        proxy.scrollTo("inspector-transcript-bottom", anchor: .bottom)
      }
      .onChange(of: resolvedDetail?.conversation?.messages.last?.id) { _, _ in
        proxy.scrollTo("inspector-transcript-bottom", anchor: .bottom)
      }
    }
  }

  /// The linked thread's recent turns, or its last agent message.
  @ViewBuilder
  private var threadMessages: some View {
    if let key = directThreadKey {
      if fleet.detailLoading.contains(key) && resolvedDetail?.conversation == nil {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Loading live thread…")
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.muted)
        }
      }
      if let rawMessages = resolvedDetail?.conversation?.messages, !rawMessages.isEmpty {
        let messages = Self.dedupedMessages(rawMessages)
        ForEach(messages) { msg in
          messageCard(
            speaker: msg.displaySpeaker,
            isOwner: msg.isOwner,
            atISO: msg.at,
            text: Self.sanitizeTranscriptText(msg.text)
          )
        }
      } else if let excerpt = resolvedDetail?.lastAgentText ?? resolvedThread?.lastAgentText ?? resolvedQuestion?.displayAskContext,
                !excerpt.isEmpty {
        messageCard(
          speaker: actorText ?? "Agent",
          isOwner: false,
          atISO: resolvedThread?.lastAgentAt,
          text: Self.sanitizeTranscriptText(excerpt)
        )
      } else if !fleet.detailLoading.contains(key) {
        Text("No transcript turns loaded yet.")
          .font(.caption)
          .foregroundStyle(WorkspaceTheme.muted)
      }
    }
  }

  private func messageCard(speaker: String, isOwner: Bool, atISO: String?, text: String) -> some View {
    let milestones = SupervisorMilestoneParser.parse(from: text)
    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        WorkspaceActorPill(actor: speaker, isOwner: isOwner)
        Spacer()
        if let at = atISO.flatMap(FleetWatching.parseDate) {
          Text(FleetThreadSummary.ago(at, now: Date()))
            .font(.caption2)
            .foregroundStyle(WorkspaceTheme.muted)
        }
      }
      WorkspaceMilestoneStrip(milestones: milestones)
      WorkspaceMarkdownContent(
        blocks: WorkspaceMarkdownParser.parse(FleetThreadSummary.tail(text, 4000)),
        bodyFont: WorkspaceTheme.Typography.secondary,
        textColor: WorkspaceTheme.ink
      )
      .textSelection(.enabled)
    }
    .padding(WorkspaceTheme.Spacing.x3)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      isOwner ? WorkspaceTheme.live.opacity(0.08) : WorkspaceTheme.surface,
      in: RoundedRectangle(cornerRadius: 12, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(WorkspaceTheme.edge, lineWidth: 0.5)
    )
  }

  private var bottomReplyDock: some View {
    let canSend = !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachedImages.isEmpty
    return VStack(alignment: .leading, spacing: 6) {
      if let replyFeedback {
        FleetNoteRow(note: replyFeedback) { self.replyFeedback = nil }
      }
      if !queuedReplies.isEmpty {
        HStack(spacing: 6) {
          Label("\(queuedReplies.count) queued", systemImage: "tray.and.arrow.down")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.live)
          Spacer()
        }
      }
      if !attachedImages.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(attachedImages) { img in
              Image(nsImage: img.preview)
                .resizable()
                .scaledToFill()
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
          }
        }
      }
      HStack(alignment: .center, spacing: 6) {
        Button {
          showAttachMenu.toggle()
        } label: {
          Image(systemName: "plus")
            .font(.system(size: 12, weight: .semibold))
            .frame(width: 26, height: 26)
            .background(WorkspaceTheme.muted.opacity(0.14), in: Circle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showAttachMenu, arrowEdge: .top) {
          VStack(alignment: .leading, spacing: 4) {
            Button("Photo or Screenshot…") {
              showAttachMenu = false
              let picked = WorkspaceImageAttachment.pickImages(limit: max(1, 4 - attachedImages.count))
              for item in picked where !attachedImages.contains(item) && attachedImages.count < 4 {
                attachedImages.append(item)
              }
            }
            .buttonStyle(.plain)
            .padding(6)

            Button("Paste Image") {
              showAttachMenu = false
              let pasted = WorkspaceImageAttachment.fromPasteboard(limit: max(1, 4 - attachedImages.count))
              for item in pasted where !attachedImages.contains(item) && attachedImages.count < 4 {
                attachedImages.append(item)
              }
            }
            .buttonStyle(.plain)
            .padding(6)
          }
          .padding(4)
        }

        TextField(
          resolvedQuestion != nil ? "Reply or unblock directly…" : "Message this session…",
          text: $draftText,
          axis: .vertical
        )
        .focused($replyFocused)
        .textFieldStyle(.plain)
        .font(WorkspaceTheme.Typography.secondary)
        .lineLimit(1...4)
        .onSubmit { sendFromInspector() }

        Button {
          sendFromInspector()
        } label: {
          if isSending && !canSend {
            ProgressView().controlSize(.small).frame(width: 26, height: 26)
          } else {
            Image(systemName: "arrow.up")
              .font(.system(size: 11, weight: .bold))
              .foregroundStyle(.white)
              .frame(width: 26, height: 26)
              .background(canSend ? WorkspaceTheme.live : WorkspaceTheme.muted.opacity(0.35), in: Circle())
          }
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .help(isSending ? "Queue next reply" : "Send reply")
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .workspaceGlassCapsule(cornerRadius: 16, focused: false)
    }
    .padding(WorkspaceTheme.Spacing.x3)
    .background(WorkspaceTheme.surface)
  }

  private func sendFromInspector() {
    let clean = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
    let imgs = attachedImages
    guard !clean.isEmpty || !imgs.isEmpty else { return }
    let text = clean.isEmpty ? "Please inspect the attached image(s)." : clean
    draftText = ""
    attachedImages = []
    replyFeedback = nil

    if isSending {
      queuedReplies.append(
        QueuedSupervisorMessage(id: "iq-\(UUID().uuidString)", text: text, focusedCardId: nil, attachments: imgs)
      )
      return
    }

    isSending = true
    Task {
      defer { isSending = false }
      var curText = text
      var curImgs = imgs
      while true {
        let note: FleetNote
        if let q = resolvedQuestion {
          note = await fleet.sendWorkspaceQuestionReply(q, message: curText, images: curImgs.map(\.fleetPayload))
        } else if let key = directThreadKey {
          note = await fleet.sendWorkspaceThreadReply(threadKey: key, message: curText, images: curImgs.map(\.fleetPayload))
          await fleet.loadDetail(key)
        } else {
          note = FleetNote(text: "No linked thread target.", isError: true)
        }
        replyFeedback = note
        guard !queuedReplies.isEmpty else { break }
        let next = queuedReplies.removeFirst()
        curText = next.text
        curImgs = next.attachments
      }
    }
  }

  private func stateTint(_ state: SupervisorBoardTaskState) -> Color {
    switch state {
    case .blocked: return WorkspaceTheme.alert
    case .claimed: return WorkspaceTheme.live
    case .waiting: return WorkspaceTheme.caution
    case .ready: return .blue
    case .done, .all: return WorkspaceTheme.muted
    }
  }
}
