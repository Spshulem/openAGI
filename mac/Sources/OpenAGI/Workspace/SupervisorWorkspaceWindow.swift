import AppKit
import SupervisorChannelsKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SupervisorWindowController {
  static let shared = SupervisorWindowController()
  private var window: NSWindow?

  func show() {
    if let win = window {
      win.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      Task {
        await SharedSupervisorClient.shared.refreshAll()
        await FleetConsumer.shared.refresh()
        await PendingApprovalConsumer.shared.refresh()
      }
      return
    }
    let root = SupervisorWorkspaceView()
      .frame(minWidth: 780, minHeight: 540)
    let host = NSHostingController(rootView: root)
    let win = NSWindow(contentViewController: host)
    win.title = "OpenAGI Supervisor Workspace"
    win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    win.setContentSize(NSSize(width: 1020, height: 700))
    win.center()
    win.isReleasedWhenClosed = false
    self.window = win
    win.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
}

private enum WorkspaceChannel: Hashable {
  case general
  case needsYou
  case tasks
  case sessions
  case project(String)
}

struct SupervisorWorkspaceView: View {
  @ObservedObject private var app = AppState.shared
  @ObservedObject private var supervisor = SharedSupervisorClient.shared
  @ObservedObject private var fleet = FleetConsumer.shared
  @ObservedObject private var approvals = PendingApprovalConsumer.shared

  @State private var channel: WorkspaceChannel = .general
  @State private var composerText = ""
  @State private var composerImages: [WorkspaceImageAttachment] = []
  @State private var composerStatusNote: String? = nil
  @State private var isDropTargeted = false
  @State private var inlineChatOpen = false
  @State private var newTaskTitle = ""

  @State private var expandedQuestionIDs: Set<String> = []
  @State private var expandedThreadKeys: Set<String> = []
  @State private var threadReplyText: [String: String] = [:]
  @State private var threadReplyImages: [String: [WorkspaceImageAttachment]] = [:]
  @State private var threadReplyBusy: Set<String> = []
  @State private var threadReplyFeedback: [String: FleetNote] = [:]

  private var decisionItems: [SupervisorDecisionItem] {
    let byKey = Dictionary(fleet.threads.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    return fleet.questions.map { q in
      let linked = q.threadKey.flatMap { byKey[$0] }
      let proj = SupervisorChannelGrouping.normalizeProject(
        explicit: q.project,
        repo: linked?.repo,
        workspace: linked?.workspace,
        cwd: linked?.cwd
      )
      return SupervisorDecisionItem(
        id: q.id,
        project: proj,
        headline: q.title,
        kindLabel: q.kind ?? "Needs you",
        risky: q.risky,
        noticedAtISO: q.askedTime
      )
    }
  }

  private var sessionBriefs: [SupervisorSessionBrief] {
    fleet.threads.map { t in
      let proj = SupervisorChannelGrouping.normalizeProject(
        explicit: nil,
        repo: t.repo,
        workspace: t.workspace,
        cwd: t.cwd
      )
      return SupervisorSessionBrief(
        id: t.key,
        project: proj,
        theme: "General",
        title: t.name,
        host: t.host,
        cwd: t.cwd,
        state: t.state ?? "idle",
        lastActivityISO: t.lastActivityAt
      )
    }
  }

  private var projectChannels: [SupervisorChannelSummary] {
    SupervisorChannelGrouping.projectChannels(from: decisionItems, sessions: sessionBriefs)
  }

  private var activeTargetLabel: String {
    switch channel {
    case .general, .needsYou, .tasks, .sessions:
      return "#general · Synced (Mac · Paseo · Phone · G2)"
    case let .project(name):
      return "#\(name) · Synced Supervisor"
    }
  }

  var body: some View {
    HStack(spacing: 0) {
      sidebar
        .frame(width: 215)
        .background(Color(nsColor: .windowBackgroundColor))

      Divider()

      VStack(spacing: 0) {
        stageHeader
        Divider()
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            switch channel {
            case .general:
              generalStage
            case .needsYou:
              needsYouStage
            case .tasks:
              tasksStage
            case .sessions:
              sessionsStage
            case let .project(projName):
              projectStage(projName)
            }
          }
          .padding(16)
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        if channel != .general && inlineChatOpen {
          Divider()
          inlineSupervisorDrawer
        }

        Divider()
        bottomComposer
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .task {
      await supervisor.refreshAll()
      await fleet.refresh()
      await approvals.refresh()
    }
  }

  // MARK: - Sidebar

  private var sidebar: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        Text("SUPERVISOR")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 10)
          .padding(.top, 12)

        channelRow(
          title: "🌐 # general",
          badge: nil,
          selected: channel == .general
        ) { channel = .general }

        channelRow(
          title: "🔔 # needs-you",
          badge: (fleet.questions.count + approvals.items.count) > 0
            ? "\(fleet.questions.count + approvals.items.count)" : nil,
          accentBadge: !fleet.questions.isEmpty,
          selected: channel == .needsYou
        ) { channel = .needsYou }

        channelRow(
          title: "✅ # tasks",
          badge: supervisor.tasks.isEmpty ? nil : "\(supervisor.tasks.count)",
          selected: channel == .tasks
        ) { channel = .tasks }

        channelRow(
          title: "⚡ # sessions",
          badge: sessionBriefs.isEmpty ? nil : "\(sessionBriefs.count)",
          selected: channel == .sessions
        ) { channel = .sessions }

        if !projectChannels.isEmpty {
          Text("PROJECT CHANNELS")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, 14)

          ForEach(projectChannels) { summary in
            let projName: String = {
              if case let .project(n) = summary.kind { return n }
              return summary.displayName
            }()
            let badgeText = summary.waitingCount > 0
              ? "\(summary.waitingCount) req"
              : summary.runningCount > 0 ? "\(summary.runningCount)●" : "\(summary.totalCount)"
            channelRow(
              title: "# \(projName)",
              badge: badgeText,
              accentBadge: summary.waitingCount > 0,
              selected: channel == .project(projName)
            ) { channel = .project(projName) }
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 16)
    }
  }

  private func channelRow(
    title: String,
    badge: String?,
    accentBadge: Bool = false,
    selected: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack {
        Text(title)
          .font(.system(size: 13, weight: selected ? .semibold : .regular))
          .foregroundStyle(selected ? Color.primary : Color.secondary)
          .lineLimit(1)
        Spacer()
        if let badge {
          Text(badge)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(accentBadge ? Color.orange : Color.secondary)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(selected ? Color.accentColor.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  // MARK: - Header

  private var stageHeader: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(headerTitle)
          .font(.headline)
        Text("\(fleet.threads.filter { $0.state == "running" }.count) running · \(fleet.questions.count) waiting · \(supervisor.tasks.count) tasks")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Button("Scan Fleet") {
        Task { await fleet.scan() }
      }
      .disabled(fleet.scanning)
      Button("Refresh") {
        Task {
          await supervisor.refreshAll()
          await fleet.refresh()
          await approvals.refresh()
          for key in expandedThreadKeys {
            await fleet.loadDetail(key)
          }
        }
      }
      Button("Web Dashboard") {
        app.openDashboard()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  private var headerTitle: String {
    switch channel {
    case .general: return "# general — Synced Supervisor"
    case .needsYou: return "# needs-you — Decisions by Project"
    case .tasks: return "# tasks — OpenAGI Todo Queue"
    case .sessions: return "# sessions — All Watched Coding Chats"
    case let .project(name): return "# \(name)"
    }
  }

  // MARK: - Stages

  @ViewBuilder
  private var generalStage: some View {
    if !fleet.questions.isEmpty || !approvals.items.isEmpty {
      HStack {
        Text("\(fleet.questions.count) decisions waiting · \(approvals.items.count) approvals · \(supervisor.tasks.count) tasks")
          .font(.subheadline.weight(.medium))
        Spacer()
        Button("Review Needs You") { channel = .needsYou }
      }
      .padding(12)
      .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    if supervisor.messages.isEmpty {
      Text("Start talking to Supervisor — attach screenshots, paste images, or ask about any thread. Synced across Mac, Paseo, iPhone, and Even G2.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      supervisorMessagesView(supervisor.messages)
    }
  }

  @ViewBuilder
  private var needsYouStage: some View {
    if !approvals.items.isEmpty {
      HStack {
        Text("Pending Tool Approvals (\(approvals.items.count))")
          .font(.subheadline.weight(.semibold))
        Spacer()
        Button("Dismiss all") {
          Task { await approvals.dismissAll() }
        }
      }
      ForEach(approvals.items) { item in
        HStack(alignment: .center, spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            Text(item.summary).font(.body.weight(.medium))
            Text(item.toolName).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Approve") { Task { await approvals.approve(item.id) } }
          Button("Deny") { Task { await approvals.deny(item.id) } }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      }
    }

    let groups = SupervisorChannelGrouping.groupByProject(decisionItems)
    if groups.isEmpty && approvals.items.isEmpty {
      Text("Queue clear — nothing waiting on you.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      ForEach(groups) { group in
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text("# \(group.project) (\(group.items.count) waiting)")
              .font(.subheadline.weight(.bold))
            Spacer()
            if group.project.lowercased() != "general" {
              Button("Open #\(group.project) ↗") {
                channel = .project(group.project)
              }
              .buttonStyle(.plain)
              .foregroundStyle(.blue)
              .font(.caption)
            }
          }
          ForEach(group.items) { item in
            if let q = fleet.questions.first(where: { $0.id == item.id }) {
              questionCardView(q)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var tasksStage: some View {
    HStack(spacing: 8) {
      TextField("Quick add task…", text: $newTaskTitle)
        .textFieldStyle(.roundedBorder)
        .onSubmit {
          let t = newTaskTitle
          newTaskTitle = ""
          Task { await supervisor.createTask(title: t) }
        }
      Button("Add Task") {
        let t = newTaskTitle
        newTaskTitle = ""
        Task { await supervisor.createTask(title: t) }
      }
      .disabled(newTaskTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    if supervisor.tasks.isEmpty {
      Text("No open tasks.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      ForEach(supervisor.tasks) { task in
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text(task.title).font(.body)
            if let notes = task.notes, !notes.isEmpty {
              Text(notes).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
          }
          Spacer()
          Button("✓ Done") {
            Task { await supervisor.completeTask(task.id) }
          }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      }
    }
  }

  @ViewBuilder
  private var sessionsStage: some View {
    if sessionBriefs.isEmpty {
      Text("No active or recently watched sessions loaded.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      let runningFirst = sessionBriefs.sorted { a, b in
        let ar = a.state == "running" ? 1 : 0
        let br = b.state == "running" ? 1 : 0
        if ar != br { return ar > br }
        return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
      }
      ForEach(runningFirst) { session in
        sessionCardView(session, showProjectTag: true)
      }
    }
  }

  @ViewBuilder
  private func projectStage(_ projName: String) -> some View {
    let overlaps = SupervisorChannelGrouping.calmOverlaps(
      for: SupervisorChannelGrouping.filterSessions(sessionBriefs, project: projName)
    )
    ForEach(overlaps) { ov in
      HStack(spacing: 8) {
        Image(systemName: "info.circle")
          .foregroundStyle(.orange)
        Text(ov.detail)
          .font(.caption.weight(.medium))
          .foregroundStyle(.orange)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    let matchingCards = decisionItems.filter {
      $0.project.caseInsensitiveCompare(projName) == .orderedSame
    }
    ForEach(matchingCards) { item in
      if let q = fleet.questions.first(where: { $0.id == item.id }) {
        questionCardView(q)
      }
    }

    let projSessions = SupervisorChannelGrouping.filterSessions(sessionBriefs, project: projName)
    if projSessions.isEmpty {
      Text("No loaded sessions in #\(projName) yet. Type below to ask Supervisor or route a goal.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      Text("Sessions (\(projSessions.count))")
        .font(.subheadline.weight(.semibold))
      ForEach(projSessions) { session in
        sessionCardView(session, showProjectTag: false)
      }
    }
  }

  // MARK: - Question & Thread Cards (Expandable Context + Transcript + Direct Reply)

  private func toggleQuestionExpand(_ q: FleetQuestion) {
    if expandedQuestionIDs.contains(q.id) {
      expandedQuestionIDs.remove(q.id)
    } else {
      expandedQuestionIDs.insert(q.id)
      if let tk = q.threadKey {
        Task { await fleet.loadDetail(tk) }
      }
    }
  }

  private func toggleThreadExpand(_ key: String) {
    if expandedThreadKeys.contains(key) {
      expandedThreadKeys.remove(key)
    } else {
      expandedThreadKeys.insert(key)
      Task { await fleet.loadDetail(key) }
    }
  }

  private func questionCardView(_ q: FleetQuestion) -> some View {
    let isExpanded = expandedQuestionIDs.contains(q.id)
    let busy = fleet.inFlight.contains(q.id) || fleet.stillSending.contains(q.id)
    let detail = q.threadKey.flatMap { fleet.details[$0] }
    let openChat = q.openChat ?? q.chats.first ?? q.threadKey.flatMap { fleet.thread($0)?.openChat } ?? detail?.openChat
    let slotKey = "q:\(q.id)"

    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          if q.risky { FleetRiskyLabel() }
          Text(q.title)
            .font(.subheadline.weight(.semibold))
            .textSelection(.enabled)
          if let label = q.chatLabel ?? openChat?.label {
            Text(label)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        Spacer()
        if let chat = openChat, let btnTitle = FleetChatOpener.buttonTitle(chat) {
          Button("\(btnTitle) ↗") {
            fleet.openChat(chat)
          }
          .controlSize(.small)
          .help(chat.link == nil ? (chat.note ?? "Bring \(chat.appName ?? "app") forward") : "Open this thread directly")
        }
        Button(isExpanded ? "Hide ▴" : "Context & Chat ▾") {
          toggleQuestionExpand(q)
        }
        .controlSize(.small)
      }

      if !q.body.isEmpty {
        Text(q.body)
          .font(.callout)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }

      HStack(spacing: 8) {
        ForEach(q.tappableOptions.prefix(4), id: \.self) { opt in
          Button(q.label(for: opt)) {
            Task { await fleet.answer(q, option: opt) }
          }
          .disabled(busy)
        }
        Button("Ask Supervisor") {
          composerText = "About \"\(q.title)\": "
          inlineChatOpen = true
        }
        .buttonStyle(.borderless)
        .font(.caption)
        Spacer()
        Button("Dismiss") {
          Task { await fleet.dismiss(q) }
        }
        .disabled(busy)
      }

      if let note = fleet.notes[q.id] {
        FleetNoteRow(note: note) { fleet.clearNote(q.id) }
      }

      if isExpanded {
        Divider()
        if let context = q.displayAskContext, !context.isEmpty {
          VStack(alignment: .leading, spacing: 3) {
            Text("Agent context:")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
            Text(context)
              .font(.callout)
              .textSelection(.enabled)
              .padding(8)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
          }
        }

        if let tk = q.threadKey {
          let thread = fleet.thread(tk)
          let summary = FleetThreadSummary(thread: thread, detail: detail)
          FleetThreadLines(summary: summary, showsExcerpt: detail?.conversation == nil && (q.displayAskContext?.isEmpty ?? true))
          FleetConversationList(conversation: detail?.conversation, loading: fleet.detailLoading.contains(tk))
        } else {
          Text("No linked live thread key; reply directly below to answer through the supervisor.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        directThreadComposer(
          slotKey: slotKey,
          placeholder: "Reply directly to this session (or attach photo)…",
          onRefresh: q.threadKey.map { tk in { Task { await fleet.loadDetail(tk) } } }
        ) { text, payloadImages in
          await fleet.sendWorkspaceQuestionReply(q, message: text, images: payloadImages)
        }
      }
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
  }

  private func sessionCardView(_ session: SupervisorSessionBrief, showProjectTag: Bool) -> some View {
    let isExpanded = expandedThreadKeys.contains(session.id)
    let thread = fleet.thread(session.id)
    let detail = fleet.details[session.id]
    let summary = FleetThreadSummary(thread: thread, detail: detail)
    let openChat = thread?.openChat ?? detail?.openChat
    let group = thread?.watch?.group
    let busy = fleet.threadInFlight.contains(session.id)
    let slotKey = "t:\(session.id)"

    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Button {
          toggleThreadExpand(session.id)
        } label: {
          HStack(spacing: 8) {
            Circle()
              .fill(session.state == "running" ? Color.green : Color.secondary.opacity(0.4))
              .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 6) {
                Text(session.title).font(.body.weight(.medium))
                if showProjectTag {
                  Text("#\(session.project)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                }
              }
              Text([session.state, session.host, session.cwd, thread?.prShortRef].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer()
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if let chat = openChat, let btnTitle = FleetChatOpener.buttonTitle(chat) {
          Button("\(btnTitle) ↗") {
            fleet.openChat(chat)
          }
          .controlSize(.small)
        }
        Button(isExpanded ? "Hide ▴" : "Context & Chat ▾") {
          toggleThreadExpand(session.id)
        }
        .controlSize(.small)
      }

      if isExpanded {
        Divider()
        FleetThreadLines(summary: summary, showsExcerpt: detail?.conversation == nil)
        FleetConversationList(conversation: detail?.conversation, loading: fleet.detailLoading.contains(session.id))

        HStack(spacing: 8) {
          if group == "push", !summary.muted, summary.pushMessage != nil {
            Button("Push now") { Task { await fleet.pushNow(session.id) } }
              .controlSize(.small)
              .buttonStyle(.borderedProminent)
              .disabled(busy || thread?.pushing == true)
          }
          Button(summary.muted ? "Unmute" : "Mute 24h") {
            Task { summary.muted ? await fleet.unmute(session.id) : await fleet.mute(session.id) }
          }
          .controlSize(.small)
          .disabled(busy)
          Button("Ask Supervisor") {
            composerText = "Check on \"\(session.title)\" (\(session.id)): "
            inlineChatOpen = true
          }
          .controlSize(.small)
          Spacer()
          if busy { ProgressView().controlSize(.small) }
        }

        if let note = fleet.threadNotes[session.id] {
          FleetNoteRow(note: note) { fleet.clearThreadNote(session.id) }
        }

        directThreadComposer(
          slotKey: slotKey,
          placeholder: "Reply directly to \(session.title) (or attach photo)…",
          onRefresh: { Task { await fleet.loadDetail(session.id) } }
        ) { text, payloadImages in
          await fleet.sendWorkspaceThreadReply(threadKey: session.id, message: text, images: payloadImages)
        }
      }
    }
    .padding(10)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
  }

  @ViewBuilder
  private func directThreadComposer(
    slotKey: String,
    placeholder: String,
    onRefresh: (() -> Void)?,
    onSubmitReply: @escaping (String, [[String: Any]]) async -> FleetNote
  ) -> some View {
    let draft = Binding<String>(
      get: { threadReplyText[slotKey] ?? "" },
      set: { threadReplyText[slotKey] = $0 }
    )
    let attached = threadReplyImages[slotKey] ?? []
    let isBusy = threadReplyBusy.contains(slotKey)

    VStack(alignment: .leading, spacing: 6) {
      if let note = threadReplyFeedback[slotKey] {
        FleetNoteRow(note: note) { threadReplyFeedback[slotKey] = nil }
      }
      if !attached.isEmpty {
        attachmentStrip(attached) { removeId in
          threadReplyImages[slotKey] = (threadReplyImages[slotKey] ?? []).filter { $0.id != removeId }
        }
      }
      HStack(spacing: 6) {
        Button {
          let picked = WorkspaceImageAttachment.pickImages(limit: max(1, 4 - attached.count))
          appendAttachments(picked, to: &threadReplyImages[slotKey, default: []])
        } label: {
          Label("Photo", systemImage: "photo.badge.plus")
            .font(.caption)
        }
        .controlSize(.small)
        .disabled(isBusy || attached.count >= 4)

        Button {
          let pasted = WorkspaceImageAttachment.fromPasteboard(limit: max(1, 4 - attached.count))
          if pasted.isEmpty {
            threadReplyFeedback[slotKey] = FleetNote(text: "Clipboard doesn't have an image.", isError: true)
          } else {
            appendAttachments(pasted, to: &threadReplyImages[slotKey, default: []])
          }
        } label: {
          Label("Paste", systemImage: "doc.on.clipboard")
            .font(.caption)
        }
        .controlSize(.small)
        .disabled(isBusy || attached.count >= 4)

        TextField(placeholder, text: draft)
          .textFieldStyle(.roundedBorder)
          .disabled(isBusy)
          .onSubmit {
            sendDirectReply(slotKey: slotKey, onSubmitReply: onSubmitReply)
          }

        if let onRefresh {
          Button {
            onRefresh()
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .controlSize(.small)
          .help("Reload thread transcript")
        }

        Button(isBusy ? "Sending…" : "Send to Thread") {
          sendDirectReply(slotKey: slotKey, onSubmitReply: onSubmitReply)
        }
        .controlSize(.small)
        .disabled(
          isBusy ||
            ((threadReplyText[slotKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attached.isEmpty)
        )
      }
    }
  }

  private func sendDirectReply(
    slotKey: String,
    onSubmitReply: @escaping (String, [[String: Any]]) async -> FleetNote
  ) {
    let text = (threadReplyText[slotKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let imgs = threadReplyImages[slotKey] ?? []
    guard !text.isEmpty || !imgs.isEmpty else { return }
    guard !threadReplyBusy.contains(slotKey) else { return }
    threadReplyBusy.insert(slotKey)
    threadReplyFeedback[slotKey] = nil
    let payloads = imgs.map(\.fleetPayload)
    Task {
      let note = await onSubmitReply(text, payloads)
      threadReplyBusy.remove(slotKey)
      threadReplyFeedback[slotKey] = note
      if !note.isError {
        threadReplyText[slotKey] = ""
        threadReplyImages[slotKey] = []
      }
    }
  }

  // MARK: - Inline Supervisor Chat Drawer & Bottom Composer

  @ViewBuilder
  private func supervisorMessagesView(_ messages: [SyncedSupervisorMessage]) -> some View {
    ForEach(messages) { msg in
      VStack(alignment: msg.role == "user" ? .trailing : .leading, spacing: 4) {
        Text(msg.role == "user" ? (msg.sourceName ?? "You") : "Supervisor")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
        let thumbs = msg.thumbnailImageData
        if !thumbs.isEmpty {
          HStack(spacing: 6) {
            ForEach(Array(thumbs.enumerated()), id: \.offset) { _, data in
              if let nsImg = NSImage(data: data) {
                Image(nsImage: nsImg)
                  .resizable()
                  .scaledToFill()
                  .frame(width: 72, height: 72)
                  .clipShape(RoundedRectangle(cornerRadius: 8))
              }
            }
          }
        }
        Text(msg.text)
          .textSelection(.enabled)
          .padding(10)
          .background(
            msg.role == "user" ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor),
            in: RoundedRectangle(cornerRadius: 10)
          )
      }
      .frame(maxWidth: .infinity, alignment: msg.role == "user" ? .trailing : .leading)
    }

    if supervisor.isSending {
      let liveText = supervisor.streamingReplyText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text("Supervisor")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
          ProgressView()
            .controlSize(.mini)
          if !liveText.isEmpty, let stage = supervisor.progressStage, !stage.isEmpty {
            Text(sendingStageLabel)
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
        Text(liveText.isEmpty ? sendingStageLabel : supervisor.streamingReplyText ?? sendingStageLabel)
          .foregroundStyle(liveText.isEmpty ? .secondary : .primary)
          .textSelection(.enabled)
          .padding(10)
          .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var sendingStageLabel: String {
    switch supervisor.progressStage {
    case "queued": return "Queued…"
    case "routing": return "Choosing the right agent…"
    case "accepted": return "Request saved…"
    case "context": return "Gathering context…"
    case "reasoning", "model": return "Thinking…"
    case "tool": return "Using tools…"
    case "saving": return "Saving the answer…"
    default: return "Working…"
    }
  }

  private var inlineSupervisorDrawer: some View {
    VStack(spacing: 0) {
      HStack {
        Text("💬 Supervisor Chat (\(supervisor.messages.count))")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer()
        Button("Full #general ↗") {
          channel = .general
        }
        .buttonStyle(.borderless)
        .font(.caption)
        Button("Minimize") {
          inlineChatOpen = false
        }
        .buttonStyle(.borderless)
        .font(.caption)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(Color(nsColor: .controlBackgroundColor).opacity(0.6))

      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          if supervisor.messages.isEmpty {
            Text("No supervisor messages yet — ask anything or attach screenshots below.")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            supervisorMessagesView(Array(supervisor.messages.suffix(12)))
          }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 220)
    }
  }

  private var bottomComposer: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("Target: \(activeTargetLabel)")
          .font(.caption2)
          .foregroundStyle(.secondary)
        Spacer()
        if channel != .general {
          Button(inlineChatOpen ? "▾ Hide Chat" : "▸ Chat (\(supervisor.messages.count))") {
            inlineChatOpen.toggle()
          }
          .buttonStyle(.borderless)
          .font(.caption2)
        }
        if let note = composerStatusNote {
          Text(note).font(.caption2).foregroundStyle(.orange).lineLimit(1)
        }
      }

      if let err = supervisor.lastError {
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.red)
          Text(err)
            .font(.caption)
            .foregroundStyle(.red)
            .lineLimit(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
          Button {
            supervisor.clearError()
          } label: {
            Image(systemName: "xmark")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
          .help("Dismiss error")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
      }

      if !composerImages.isEmpty {
        attachmentStrip(composerImages) { removeId in
          composerImages.removeAll { $0.id == removeId }
        }
      }

      HStack(spacing: 8) {
        Button {
          composerStatusNote = nil
          let picked = WorkspaceImageAttachment.pickImages(limit: max(1, 4 - composerImages.count))
          appendAttachments(picked, to: &composerImages)
        } label: {
          Label(
            composerImages.isEmpty ? "+ Photo" : "+\(composerImages.count)",
            systemImage: "photo.badge.plus"
          )
        }
        .disabled(supervisor.isSending || composerImages.count >= 4)
        .help("Attach up to 4 images or screenshots")

        Button {
          let pasted = WorkspaceImageAttachment.fromPasteboard(limit: max(1, 4 - composerImages.count))
          if pasted.isEmpty {
            composerStatusNote = "Clipboard has no image to attach."
          } else {
            composerStatusNote = nil
            appendAttachments(pasted, to: &composerImages)
          }
        } label: {
          Image(systemName: "doc.on.clipboard")
        }
        .disabled(supervisor.isSending || composerImages.count >= 4)
        .help("Paste image from clipboard")

        TextField(
          channel == .general
            ? "Ask Supervisor anything or drop/attach photos (synced across all devices)…"
            : "Ask Supervisor about #\(channelNameForPlaceholder) or attach photos…",
          text: $composerText
        )
        .textFieldStyle(.roundedBorder)
        .disabled(supervisor.isSending)
        .onSubmit { sendFromWorkspace() }

        Button(supervisor.isSending ? "Sending…" : "Send") {
          sendFromWorkspace()
        }
        .disabled(
          supervisor.isSending ||
            (composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && composerImages.isEmpty)
        )
      }
      .padding(4)
      .background(isDropTargeted ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
      .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
        Task {
          let dropped = await WorkspaceImageAttachment.fromDropProviders(
            providers,
            limit: max(1, 4 - composerImages.count)
          )
          await MainActor.run {
            composerStatusNote = nil
            appendAttachments(dropped, to: &composerImages)
          }
        }
        return true
      }
    }
    .padding(12)
    .background(.ultraThinMaterial)
  }

  private func attachmentStrip(_ items: [WorkspaceImageAttachment], onRemove: @escaping (String) -> Void) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(items) { item in
          ZStack(alignment: .topTrailing) {
            Image(nsImage: item.preview)
              .resizable()
              .scaledToFill()
              .frame(width: 56, height: 56)
              .clipShape(RoundedRectangle(cornerRadius: 8))
            Button {
              onRemove(item.id)
            } label: {
              Image(systemName: "xmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.white, .black.opacity(0.7))
            }
            .buttonStyle(.plain)
            .offset(x: 4, y: -4)
          }
          .padding(.top, 4)
          .padding(.trailing, 4)
        }
      }
    }
  }

  private func appendAttachments(_ incoming: [WorkspaceImageAttachment], to target: inout [WorkspaceImageAttachment]) {
    for item in incoming where target.count < 4 {
      if !target.contains(item) {
        target.append(item)
      }
    }
  }

  private var channelNameForPlaceholder: String {
    if case let .project(name) = channel { return name }
    return "general"
  }

  private func sendFromWorkspace() {
    let rawDraft = composerText
    let raw = rawDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    let imgs = composerImages
    guard !raw.isEmpty || !imgs.isEmpty else { return }
    let textToSend: String
    if case let .project(projName) = channel {
      textToSend = raw.isEmpty ? "[\(projName)] Please inspect the attached screenshot(s)." : "[\(projName)] \(raw)"
      inlineChatOpen = true
    } else if channel != .general {
      textToSend = raw
      inlineChatOpen = true
    } else {
      textToSend = raw
    }
    composerText = ""
    composerImages = []
    composerStatusNote = nil
    Task {
      let ok = await supervisor.sendMessage(textToSend, attachments: imgs)
      if !ok {
        if composerText.isEmpty {
          composerText = rawDraft
        }
        if composerImages.isEmpty && !imgs.isEmpty {
          composerImages = imgs
        }
      }
    }
  }
}
