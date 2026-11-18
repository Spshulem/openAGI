import AppKit
import SupervisorChannelsKit
import SwiftUI

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
      .frame(minWidth: 740, minHeight: 500)
    let host = NSHostingController(rootView: root)
    let win = NSWindow(contentViewController: host)
    win.title = "OpenAGI Supervisor Workspace"
    win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    win.setContentSize(NSSize(width: 980, height: 680))
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
  case project(String)
}

struct SupervisorWorkspaceView: View {
  @ObservedObject private var app = AppState.shared
  @ObservedObject private var supervisor = SharedSupervisorClient.shared
  @ObservedObject private var fleet = FleetConsumer.shared
  @ObservedObject private var approvals = PendingApprovalConsumer.shared

  @State private var channel: WorkspaceChannel = .general
  @State private var composerText = ""
  @State private var newTaskTitle = ""

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
    case .general, .needsYou, .tasks:
      return "#general · Synced (Mac · Paseo · Phone · G2)"
    case let .project(name):
      return "#\(name) · Synced Supervisor"
    }
  }

  var body: some View {
    HStack(spacing: 0) {
      sidebar
        .frame(width: 225)
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
            case let .project(projName):
              projectStage(projName)
            }
          }
          .padding(16)
          .frame(maxWidth: .infinity, alignment: .leading)
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
    case let .project(name): return "# \(name)"
    }
  }

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
      Text("Start talking to Supervisor — your thread stays synced across Mac Floater, Mac Workspace, Paseo, iPhone, and Even G2.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      ForEach(supervisor.messages) { msg in
        VStack(alignment: msg.role == "user" ? .trailing : .leading, spacing: 4) {
          Text(msg.role == "user" ? (msg.sourceName ?? "You") : "Supervisor")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
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
      Text("No loaded sessions in #\(projName) yet. Type below to start or route one.")
        .font(.callout)
        .foregroundStyle(.secondary)
    } else {
      Text("Sessions (\(projSessions.count))")
        .font(.subheadline.weight(.semibold))
      ForEach(projSessions) { session in
        HStack {
          Circle()
            .fill(session.state == "running" ? Color.green : Color.secondary.opacity(0.4))
            .frame(width: 8, height: 8)
          VStack(alignment: .leading, spacing: 2) {
            Text(session.title).font(.body.weight(.medium))
            Text([session.state, session.host, session.cwd].compactMap { $0 }.joined(separator: " · "))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button("Ask in #general") {
            composerText = "Check on \(session.title) in #\(projName): "
            channel = .general
          }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      }
    }
  }

  private func questionCardView(_ q: FleetQuestion) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(q.title).font(.subheadline.weight(.semibold))
        Spacer()
        if let label = q.chatLabel {
          Text(label).font(.caption).foregroundStyle(.secondary)
        }
      }
      if !q.body.isEmpty {
        Text(q.body).font(.callout).foregroundStyle(.secondary)
      }
      HStack(spacing: 8) {
        ForEach(q.tappableOptions.prefix(4), id: \.self) { opt in
          Button(q.label(for: opt)) {
            Task { await fleet.answer(q, option: opt) }
          }
          .disabled(fleet.inFlight.contains(q.id))
        }
        Spacer()
        Button("Dismiss") {
          Task { await fleet.dismiss(q) }
        }
        .disabled(fleet.inFlight.contains(q.id))
      }
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
  }

  private var bottomComposer: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("Target: \(activeTargetLabel)")
          .font(.caption2)
          .foregroundStyle(.secondary)
        Spacer()
        if let err = supervisor.lastError {
          Text(err).font(.caption2).foregroundStyle(.red).lineLimit(1)
        }
      }
      HStack(spacing: 8) {
        TextField(
          channel == .general
            ? "Ask Supervisor anything (synced across all devices)…"
            : "Ask Supervisor about #\(channelNameForPlaceholder)…",
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
            composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
      }
    }
    .padding(12)
    .background(.ultraThinMaterial)
  }

  private var channelNameForPlaceholder: String {
    if case let .project(name) = channel { return name }
    return "general"
  }

  private func sendFromWorkspace() {
    let raw = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return }
    let textToSend: String
    if case let .project(projName) = channel {
      textToSend = "[\(projName)] \(raw)"
    } else {
      textToSend = raw
    }
    composerText = ""
    channel = .general
    Task { await supervisor.sendMessage(textToSend) }
  }
}
