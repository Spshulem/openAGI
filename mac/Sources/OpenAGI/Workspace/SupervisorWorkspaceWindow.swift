import AppKit
import SupervisorChannelsKit
import SwiftUI
import UniformTypeIdentifiers

enum WorkspaceChannel: Hashable {
  case general
  case needsYou
  case tasks
  case sessions
  case project(String)
}

@MainActor
final class SupervisorWorkspaceNavigation: ObservableObject {
  @Published var selectedChannel: WorkspaceChannel? = .general
}

@MainActor
final class SupervisorWindowController {
  static let shared = SupervisorWindowController()
  private var window: NSWindow?
  private let navigation = SupervisorWorkspaceNavigation()

  func show(channel: WorkspaceChannel? = nil) {
    if let channel {
      navigation.selectedChannel = channel
    }
    if AppState.shared.showsInDock {
      AppDelegate.applyActivationPolicy(showsInDock: true)
    }
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
    let root = SupervisorWorkspaceView(nav: navigation)
      .frame(minWidth: 820, minHeight: 580)
    let host = NSHostingController(rootView: root)
    let win = NSWindow(contentViewController: host)
    win.title = "OpenAGI"
    win.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    win.toolbarStyle = .unified
    win.titleVisibility = .visible
    win.setContentSize(NSSize(width: 1100, height: 740))
    win.center()
    win.setFrameAutosaveName("OpenAGISupervisorWorkspace")
    win.isReleasedWhenClosed = false
    win.collectionBehavior = [.managed, .participatesInCycle]
    self.window = win
    win.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
}

private struct StarterPrompt: Identifiable {
  let id: String
  let symbol: String
  let title: String
  let detail: String
  let prompt: String
}

private let supervisorStarters: [StarterPrompt] = [
  StarterPrompt(
    id: "needs",
    symbol: "bell.badge",
    title: "Summarize what needs me",
    detail: "Prioritized decisions, blockers, and tool approvals across projects",
    prompt: "Summarize everything currently waiting on my decision across all active sessions."
  ),
  StarterPrompt(
    id: "sessions",
    symbol: "terminal",
    title: "Check active coding sessions",
    detail: "Status, current branch or PR state, and next suggested step",
    prompt: "Give me a quick status brief on all running and idle coding sessions."
  ),
  StarterPrompt(
    id: "task",
    symbol: "checklist",
    title: "Track a new follow-up task",
    detail: "Capture a task in my synced queue for later review",
    prompt: "Add a task to my queue: "
  )
]

struct SupervisorWorkspaceView: View {
  @ObservedObject var nav: SupervisorWorkspaceNavigation
  @ObservedObject private var app = AppState.shared
  @ObservedObject private var supervisor = SharedSupervisorClient.shared
  @ObservedObject private var fleet = FleetConsumer.shared
  @ObservedObject private var approvals = PendingApprovalConsumer.shared

  @State private var columnVisibility: NavigationSplitViewVisibility = .all
  @State private var searchQuery = ""
  @State private var composerText = ""
  @State private var composerImages: [WorkspaceImageAttachment] = []
  @State private var composerStatusNote: String? = nil
  @State private var isDropTargeted = false
  @State private var inlineChatOpen = false
  @State private var showAttachPopover = false
  @State private var newTaskTitle = ""
  @FocusState private var composerFocused: Bool
  @State private var hostWindow: NSWindow?
  @State private var pasteKeyMonitor: Any?

  @State private var expandedQuestionIDs: Set<String> = []
  @State private var revealedPlanQuestionIDs: Set<String> = []
  @State private var expandedThreadKeys: Set<String> = []
  @State private var threadReplyText: [String: String] = [:]
  @State private var threadReplyImages: [String: [WorkspaceImageAttachment]] = [:]
  @State private var threadReplyQueues: [String: [QueuedSupervisorMessage]] = [:]
  @State private var threadReplyBusy: Set<String> = []
  @State private var threadReplyFeedback: [String: FleetNote] = [:]
  @State private var threadAttachPopoverSlot: String? = nil
  @FocusState private var focusedThreadSlot: String?

  @State private var showNewSessionCreator = false
  @State private var newSessionWorkspace = ""
  @State private var newSessionModel = "gpt-5.4"
  @State private var newSessionEffort = "medium"
  @State private var newSessionTitle = ""
  @State private var newSessionPrompt = ""
  @State private var newSessionImages: [WorkspaceImageAttachment] = []
  @State private var isStartingSession = false
  @State private var newSessionNote: FleetNote? = nil

  private var activeChannel: WorkspaceChannel {
    nav.selectedChannel ?? .general
  }

  private var waitingTotal: Int {
    fleet.questions.count + approvals.items.count
  }

  private var runningCount: Int {
    fleet.threads.filter { $0.state == "running" }.count
  }

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

  private var navigationTitleText: String {
    switch activeChannel {
    case .general: return "Supervisor"
    case .needsYou: return "Needs You"
    case .tasks: return "Tasks"
    case .sessions: return "Sessions"
    case let .project(name): return "#\(name)"
    }
  }

  private var navigationSubtitleText: String {
    switch activeChannel {
    case .general:
      return "Synced across Mac, Paseo, iPhone, and Even G2 · \(runningCount) running · \(waitingTotal) waiting"
    case .needsYou:
      return waitingTotal == 0 ? "Queue clear" : "\(waitingTotal) awaiting decision or approval"
    case .tasks:
      return "\(supervisor.tasks.count) open task\(supervisor.tasks.count == 1 ? "" : "s")"
    case .sessions:
      return "\(runningCount) running · \(sessionBriefs.count) watched"
    case let .project(name):
      let count = SupervisorChannelGrouping.filterSessions(sessionBriefs, project: name).count
      return "\(count) session\(count == 1 ? "" : "s") in #\(name)"
    }
  }

  private var activeTargetLabel: String {
    switch activeChannel {
    case .general, .needsYou, .tasks, .sessions:
      return "Synced Supervisor (Mac · Paseo · Phone · G2)"
    case let .project(name):
      return "Scoped to #\(name) · Synced Supervisor"
    }
  }

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      sidebar
    } detail: {
      detailStage
    }
    .navigationSplitViewStyle(.balanced)
    .task {
      await supervisor.refreshAll()
      await fleet.refresh()
      await approvals.refresh()
      AppDelegate.updateDockBadge(count: waitingTotal)
    }
    .onChange(of: waitingTotal) { _, count in
      AppDelegate.updateDockBadge(count: count)
    }
    .background(WorkspaceWindowAccessor(window: $hostWindow))
    .onAppear {
      installPasteMonitor()
    }
    .onDisappear {
      removePasteMonitor()
    }
  }

  // MARK: - Sidebar (Floating Liquid Glass on macOS 26/27)

  private var sidebar: some View {
    List(selection: $nav.selectedChannel) {
      Section("Supervisor") {
        sidebarBadgeRow(title: "General", systemImage: "binoculars", count: 0, highlight: false)
          .tag(WorkspaceChannel.general)

        sidebarBadgeRow(title: "Needs You", systemImage: "bell.badge", count: waitingTotal, highlight: waitingTotal > 0)
          .tag(WorkspaceChannel.needsYou)

        sidebarBadgeRow(title: "Tasks", systemImage: "checklist", count: supervisor.tasks.count, highlight: false)
          .tag(WorkspaceChannel.tasks)

        sidebarBadgeRow(title: "Sessions", systemImage: "terminal", count: sessionBriefs.count, highlight: false)
          .tag(WorkspaceChannel.sessions)
      }

      if !projectChannels.isEmpty {
        Section("Projects") {
          ForEach(projectChannels) { summary in
            let projName = projectName(for: summary)
            let count = summary.waitingCount > 0 ? summary.waitingCount : summary.totalCount
            sidebarBadgeRow(
              title: "# \(projName)",
              systemImage: summary.waitingCount > 0 ? "exclamationmark.circle.fill" : "folder",
              count: count,
              highlight: summary.waitingCount > 0
            )
            .tag(WorkspaceChannel.project(projName))
          }
        }
      }
    }
    .listStyle(.sidebar)
    .navigationSplitViewColumnWidth(min: 205, ideal: 232, max: 275)
  }

  private func projectName(for summary: SupervisorChannelSummary) -> String {
    if case let .project(name) = summary.kind { return name }
    return summary.displayName
  }

  private func sidebarBadgeRow(title: String, systemImage: String, count: Int, highlight: Bool) -> some View {
    HStack(spacing: 8) {
      Label(title, systemImage: systemImage)
        .lineLimit(1)
      Spacer(minLength: 4)
      if count > 0 {
        Text("\(count)")
          .font(.caption2.weight(.semibold))
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(
            (highlight ? WorkspaceTheme.caution : WorkspaceTheme.muted).opacity(0.16),
            in: Capsule()
          )
          .foregroundStyle(highlight ? WorkspaceTheme.caution : WorkspaceTheme.muted)
      }
    }
  }

  // MARK: - Detail Stage + Unified Liquid Glass Toolbar

  private var detailStage: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x4) {
          switch activeChannel {
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
          Color.clear
            .frame(height: 1)
            .id("workspace-bottom-anchor")
        }
        .padding(.horizontal, WorkspaceTheme.Spacing.x6)
        .padding(.top, WorkspaceTheme.Spacing.x4)
        .padding(.bottom, WorkspaceTheme.Spacing.x5)
        .frame(maxWidth: activeChannel == .general ? 760 : 860, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .onChange(of: supervisor.messages.count) { _, _ in
        if activeChannel == .general {
          proxy.scrollTo("workspace-bottom-anchor", anchor: .bottom)
        }
      }
      .onChange(of: supervisor.streamingReplyText) { _, text in
        if activeChannel == .general, text != nil {
          proxy.scrollTo("workspace-bottom-anchor", anchor: .bottom)
        }
      }
      .onChange(of: activeChannel) { _, next in
        if next == .general {
          Task { @MainActor in
            proxy.scrollTo("workspace-bottom-anchor", anchor: .bottom)
          }
        }
      }
    }
    .background(WorkspaceTheme.canvas)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      floatingBottomDock
    }
    .navigationTitle(navigationTitleText)
    .navigationSubtitle(navigationSubtitleText)
    .searchable(text: $searchQuery, placement: .toolbar, prompt: "Filter messages, sessions, tasks…")
    .toolbar { toolbarItems }
  }

  @ToolbarContentBuilder
  private var toolbarItems: some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      Button {
        nav.selectedChannel = waitingTotal > 0 ? .needsYou : .sessions
      } label: {
        HStack(spacing: 6) {
          Circle()
            .fill(runningCount > 0 ? WorkspaceTheme.live : (waitingTotal > 0 ? WorkspaceTheme.caution : WorkspaceTheme.muted))
            .frame(width: 7, height: 7)
          Text(waitingTotal > 0 ? "\(waitingTotal) waiting" : "\(runningCount) active")
            .font(.caption.weight(.medium))
        }
      }
      .help("Jump to Needs You or active sessions")

      Menu {
        if supervisor.claudeCliAvailable || supervisor.codexCliAvailable || supervisor.chatgptSignedIn {
          Section("Accounts (Pass-Through)") {
            if supervisor.claudeCliAvailable {
              ForEach(MacModelOption.curatedClaude) { option in
                Button {
                  Task {
                    await supervisor.selectModelPreference(
                      preference: "claude-cli",
                      modelField: "claudeCliModel",
                      modelId: option.id
                    )
                  }
                } label: {
                  if supervisor.activeProvider == "claude-cli" && supervisor.activeModelId == option.id {
                    Label("Claude Account · \(option.label)", systemImage: "checkmark")
                  } else {
                    Text("Claude Account · \(option.label)")
                  }
                }
              }
            }
            if supervisor.codexCliAvailable {
              Button {
                Task {
                  await supervisor.selectModelPreference(
                    preference: "codex-cli",
                    modelField: "codexCliModel",
                    modelId: "gpt-5.4"
                  )
                }
              } label: {
                if supervisor.activeProvider == "codex-cli" {
                  Label("Codex Account · GPT-5.4", systemImage: "checkmark")
                } else {
                  Text("Codex Account · GPT-5.4")
                }
              }
            }
            if supervisor.chatgptSignedIn {
              Button {
                Task { await supervisor.selectModelPreference(preference: "chatgpt") }
              } label: {
                if supervisor.activeProvider == "chatgpt" {
                  Label("ChatGPT Plan", systemImage: "checkmark")
                } else {
                  Text("ChatGPT Plan")
                }
              }
            }
          }
        }
        Section("OpenAI API") {
          ForEach(MacModelOption.curatedOpenAI) { option in
            Button {
              Task { await supervisor.selectOpenAIModel(option.id) }
            } label: {
              if supervisor.activeProvider == "openai" && supervisor.activeModelId == option.id {
                Label(option.label, systemImage: "checkmark")
              } else {
                Text(option.label)
              }
            }
          }
        }
        if supervisor.anthropicConfigured {
          Section("Claude API") {
            ForEach(MacModelOption.curatedClaude) { option in
              Button {
                Task {
                  await supervisor.selectModelPreference(
                    preference: "anthropic",
                    modelField: "anthropicModel",
                    modelId: option.id
                  )
                }
              } label: {
                if supervisor.activeProvider == "anthropic" && supervisor.activeModelId == option.id {
                  Label(option.label, systemImage: "checkmark")
                } else {
                  Text(option.label)
                }
              }
            }
          }
        }
      } label: {
        Label(supervisor.isSwitchingModel ? "Switching…" : supervisor.activeModelLabel, systemImage: "cpu")
      }
      .help("Select active Supervisor model or account pass-through")

      Button {
        Task { await fleet.scan() }
      } label: {
        Label(fleet.scanning ? "Scanning…" : "Scan", systemImage: "arrow.clockwise")
      }
      .disabled(fleet.scanning)
      .help("Scan coding agents now (⌘R)")

      Menu {
        if let currentMode = fleet.status?.mode {
          Menu("Supervisor Mode (\(currentMode.capitalized))") {
            ForEach(["observe", "propose", "auto"], id: \.self) { mode in
              Button {
                Task { await supervisor.setFleetMode(mode) }
              } label: {
                if currentMode == mode {
                  Label(mode.capitalized, systemImage: "checkmark")
                } else {
                  Text(mode.capitalized)
                }
              }
            }
          }
        }
        Button("Refresh Everything") {
          Task {
            await supervisor.refreshAll()
            await fleet.refresh()
            await approvals.refresh()
            for key in expandedThreadKeys {
              await fleet.loadDetail(key)
            }
          }
        }
        Button("Quick Ask  ⌥Space") { OverlayController.shared.toggle() }
        Divider()
        Button("Connect Phone…") { PhonePairingWindowController.shared.show(state: app) }
        Button("Permissions & Privacy…") { PrivacyWindowController.shared.show() }
        Button("Open Web Dashboard ↗") { app.openDashboard() }
      } label: {
        Label("More", systemImage: "ellipsis.circle")
      }
    }
  }

  // MARK: - Search Filtering Helpers

  private var trimmedQuery: String {
    searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func matchesQuery(_ parts: [String?]) -> Bool {
    guard !trimmedQuery.isEmpty else { return true }
    let joined = parts.compactMap { $0 }.joined(separator: " ")
    return joined.localizedCaseInsensitiveContains(trimmedQuery)
  }

  // MARK: - Stages

  @ViewBuilder
  private var generalStage: some View {
    if waitingTotal > 0 {
      HStack(spacing: WorkspaceTheme.Spacing.x3) {
        Image(systemName: "bell.badge.fill")
          .foregroundStyle(WorkspaceTheme.caution)
        VStack(alignment: .leading, spacing: 2) {
          Text("\(waitingTotal) item\(waitingTotal == 1 ? "" : "s") need your input")
            .font(WorkspaceTheme.Typography.secondary.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.ink)
          Text("\(fleet.questions.count) decisions · \(approvals.items.count) tool approvals · \(supervisor.tasks.count) tasks")
            .font(WorkspaceTheme.Typography.caption)
            .foregroundStyle(WorkspaceTheme.muted)
        }
        Spacer()
        WorkspaceActionButton(prominent: true, small: true) {
          nav.selectedChannel = .needsYou
        } label: {
          Text("Review")
        }
      }
      .padding(WorkspaceTheme.Spacing.x3)
      .workspaceCardSurface(cornerRadius: WorkspaceTheme.cardRadius)
    }

    let visibleMessages = supervisor.messages.filter {
      matchesQuery([$0.text, $0.sourceName])
    }

    if supervisor.messages.isEmpty {
      generalEmptyHero
    } else if visibleMessages.isEmpty {
      Text("No messages matching \"\(trimmedQuery)\".")
        .font(WorkspaceTheme.Typography.secondary)
        .foregroundStyle(WorkspaceTheme.muted)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, WorkspaceTheme.Spacing.x8)
    } else {
      supervisorMessagesView(visibleMessages)
    }
  }

  private var generalEmptyHero: some View {
    VStack(spacing: WorkspaceTheme.Spacing.x6) {
      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        Image(systemName: "binoculars")
          .font(.title)
          .foregroundStyle(WorkspaceTheme.live)
          .frame(width: 56, height: 56)
          .background(WorkspaceTheme.live.opacity(0.12), in: Circle())

        Text("Your coding agents, one thread")
          .font(.title2.bold())
          .foregroundStyle(WorkspaceTheme.ink)
          .multilineTextAlignment(.center)

        Text("Ask about any session, drop screenshots to debug, or manage your synced tasks across Mac, Paseo, iPhone, and Even G2.")
          .font(WorkspaceTheme.Typography.secondary)
          .foregroundStyle(WorkspaceTheme.muted)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 460)
      }
      .frame(maxWidth: .infinity)

      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        ForEach(supervisorStarters) { starter in
          Button {
            composerText = starter.prompt
            composerFocused = true
          } label: {
            HStack(spacing: WorkspaceTheme.Spacing.x3) {
              Image(systemName: starter.symbol)
                .font(.body)
                .foregroundStyle(WorkspaceTheme.live)
                .frame(width: 28)
              VStack(alignment: .leading, spacing: 2) {
                Text(starter.title)
                  .font(WorkspaceTheme.Typography.body.weight(.semibold))
                  .foregroundStyle(WorkspaceTheme.ink)
                Text(starter.detail)
                  .font(WorkspaceTheme.Typography.secondary)
                  .foregroundStyle(WorkspaceTheme.muted)
              }
              Spacer(minLength: 0)
              Image(systemName: "arrow.up.left")
                .font(.caption)
                .foregroundStyle(WorkspaceTheme.muted)
            }
            .padding(WorkspaceTheme.Spacing.x4)
            .frame(maxWidth: 520, alignment: .leading)
            .workspaceCardSurface(cornerRadius: WorkspaceTheme.cardRadius)
          }
          .buttonStyle(.plain)
        }
      }
      .frame(maxWidth: .infinity)
    }
    .padding(.vertical, WorkspaceTheme.Spacing.x8)
  }

  @ViewBuilder
  private var needsYouStage: some View {
    let filteredApprovals = approvals.items.filter { matchesQuery([$0.summary, $0.toolName]) }
    if !filteredApprovals.isEmpty {
      HStack {
        Text("Pending Tool Approvals (\(filteredApprovals.count))")
          .font(WorkspaceTheme.Typography.section)
          .foregroundStyle(WorkspaceTheme.ink)
        Spacer()
        WorkspaceActionButton(small: true) {
          Task { await approvals.dismissAll() }
        } label: {
          Text("Dismiss all")
        }
      }

      WorkspaceRowGroup {
        ForEach(Array(filteredApprovals.enumerated()), id: \.element.id) { idx, item in
          if idx > 0 { WorkspaceHairline() }
          HStack(alignment: .center, spacing: WorkspaceTheme.Spacing.x3) {
            VStack(alignment: .leading, spacing: 2) {
              Text(item.summary)
                .font(WorkspaceTheme.Typography.body.weight(.medium))
                .foregroundStyle(WorkspaceTheme.ink)
              Text(item.toolName)
                .font(WorkspaceTheme.Typography.dataMono)
                .foregroundStyle(WorkspaceTheme.muted)
            }
            Spacer()
            WorkspaceActionButton(small: true) {
              Task { await approvals.deny(item.id) }
            } label: {
              Text("Deny")
            }
            WorkspaceActionButton(prominent: true, small: true) {
              Task { await approvals.approve(item.id) }
            } label: {
              Text("Approve")
            }
          }
          .padding(WorkspaceTheme.Spacing.x3)
        }
      }
    }

    let filteredDecisions = decisionItems.filter { item in
      let q = fleet.questions.first(where: { $0.id == item.id })
      return matchesQuery([item.project, item.headline, q?.body])
    }
    let groups = SupervisorChannelGrouping.groupByProject(filteredDecisions)

    if groups.isEmpty && filteredApprovals.isEmpty {
      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        Text(trimmedQuery.isEmpty ? "Queue clear" : "Nothing matching \"\(trimmedQuery)\"")
          .font(WorkspaceTheme.Typography.body.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
        Text("Decisions and approvals from your coding agents appear here.")
          .font(WorkspaceTheme.Typography.secondary)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, WorkspaceTheme.Spacing.x8)
    } else {
      ForEach(groups) { group in
        VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
          HStack {
            Text("#\(group.project) · \(group.items.count) waiting")
              .font(WorkspaceTheme.Typography.section)
              .foregroundStyle(WorkspaceTheme.ink)
            Spacer()
            if group.project.lowercased() != "general" {
              Button("Open #\(group.project) ↗") {
                nav.selectedChannel = .project(group.project)
              }
              .buttonStyle(.plain)
              .foregroundStyle(WorkspaceTheme.live)
              .font(WorkspaceTheme.Typography.caption.weight(.semibold))
            }
          }
          .padding(.top, WorkspaceTheme.Spacing.x2)

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
    HStack(spacing: WorkspaceTheme.Spacing.x2) {
      Image(systemName: "plus.circle.fill")
        .foregroundStyle(WorkspaceTheme.live)
        .font(.title3)
      TextField("Add a synced task…", text: $newTaskTitle)
        .textFieldStyle(.plain)
        .font(WorkspaceTheme.Typography.body)
        .onSubmit {
          let t = newTaskTitle
          newTaskTitle = ""
          Task { await supervisor.createTask(title: t) }
        }
      WorkspaceActionButton(prominent: true, small: true) {
        let t = newTaskTitle
        newTaskTitle = ""
        Task { await supervisor.createTask(title: t) }
      } label: {
        Text("Add")
      }
      .disabled(newTaskTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .padding(.horizontal, WorkspaceTheme.Spacing.x4)
    .padding(.vertical, 10)
    .workspaceGlassCapsule(cornerRadius: 16, focused: false)

    let visibleTasks = supervisor.tasks.filter { matchesQuery([$0.title, $0.notes]) }
    if visibleTasks.isEmpty {
      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        Text(trimmedQuery.isEmpty ? "No open tasks." : "No tasks matching \"\(trimmedQuery)\".")
          .font(WorkspaceTheme.Typography.body.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
        Text("New tasks added here or from your phone sync automatically.")
          .font(WorkspaceTheme.Typography.secondary)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, WorkspaceTheme.Spacing.x8)
    } else {
      WorkspaceRowGroup {
        ForEach(Array(visibleTasks.enumerated()), id: \.element.id) { idx, task in
          if idx > 0 { WorkspaceHairline() }
          HStack(spacing: WorkspaceTheme.Spacing.x3) {
            Button {
              Task { await supervisor.completeTask(task.id) }
            } label: {
              Image(systemName: "circle")
                .font(.title3)
                .foregroundStyle(WorkspaceTheme.live)
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help("Complete task")

            VStack(alignment: .leading, spacing: 2) {
              Text(task.title)
                .font(WorkspaceTheme.Typography.body)
                .foregroundStyle(WorkspaceTheme.ink)
                .textSelection(.enabled)
              if let notes = task.notes, !notes.isEmpty {
                Text(notes)
                  .font(WorkspaceTheme.Typography.caption)
                  .foregroundStyle(WorkspaceTheme.muted)
                  .lineLimit(2)
              }
            }
            Spacer()
          }
          .padding(.horizontal, WorkspaceTheme.Spacing.x4)
          .padding(.vertical, WorkspaceTheme.Spacing.x3)
        }
      }
    }
  }

  @ViewBuilder
  private var sessionsStage: some View {
    newSessionBar(defaultWorkspace: nil)
    let filtered = sessionBriefs.filter { matchesQuery([$0.title, $0.project, $0.host, $0.cwd]) }
    if filtered.isEmpty {
      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        Text(trimmedQuery.isEmpty ? "No coding sessions loaded." : "No sessions matching \"\(trimmedQuery)\".")
          .font(WorkspaceTheme.Typography.body.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
        Text("Press Scan in the toolbar to discover active Paseo, Conductor, or Codex threads, or start a new one above.")
          .font(WorkspaceTheme.Typography.secondary)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, WorkspaceTheme.Spacing.x8)
    } else {
      let runningFirst = filtered.sorted { a, b in
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
  private func newSessionBar(defaultWorkspace: String?) -> some View {
    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
      HStack {
        Text(defaultWorkspace.map { "New Session in #\($0)" } ?? "Start Paseo Session")
          .font(WorkspaceTheme.Typography.section)
          .foregroundStyle(WorkspaceTheme.ink)
        Spacer()
        WorkspaceActionButton(prominent: !showNewSessionCreator, small: true) {
          withAnimation(.easeOut(duration: 0.16)) {
            showNewSessionCreator.toggle()
          }
          if showNewSessionCreator {
            if let defaultWorkspace, newSessionWorkspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              newSessionWorkspace = defaultWorkspace
            }
            newSessionNote = nil
            Task { await fleet.loadWorkspaces() }
          }
        } label: {
          Label(showNewSessionCreator ? "Close" : "+ New Session", systemImage: showNewSessionCreator ? "xmark" : "plus.circle.fill")
        }
      }

      if let note = newSessionNote {
        FleetNoteRow(note: note) { newSessionNote = nil }
      }

      if showNewSessionCreator {
        VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
          HStack(spacing: WorkspaceTheme.Spacing.x2) {
            TextField("Workspace (blank = auto-pick active)", text: $newSessionWorkspace)
              .textFieldStyle(.roundedBorder)
              .font(WorkspaceTheme.Typography.secondary)

            if !fleet.workspaces.isEmpty {
              Menu("Pick Workspace") {
                Button("Auto-select active workspace") { newSessionWorkspace = defaultWorkspace ?? "" }
                Divider()
                ForEach(fleet.workspaces) { ws in
                  Button(ws.name) { newSessionWorkspace = ws.name }
                }
              }
              .font(WorkspaceTheme.Typography.caption)
            }
          }

          HStack(spacing: WorkspaceTheme.Spacing.x3) {
            Picker("Model", selection: $newSessionModel) {
              Text("GPT-5.4").tag("gpt-5.4")
              Text("GPT-6.2 Sol").tag("gpt-6.2-sol")
              Text("Claude Sonnet 4.6").tag("claude-sonnet-4-6")
              Text("Claude Opus 4.7").tag("claude-opus-4-7")
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 220)

            Picker("Effort", selection: $newSessionEffort) {
              Text("Low").tag("low")
              Text("Medium").tag("medium")
              Text("High").tag("high")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 220)
          }

          TextField("Optional session title", text: $newSessionTitle)
            .textFieldStyle(.roundedBorder)
            .font(WorkspaceTheme.Typography.secondary)

          TextField("What should the Paseo coding session work on?", text: $newSessionPrompt, axis: .vertical)
            .textFieldStyle(.roundedBorder)
            .font(WorkspaceTheme.Typography.secondary)
            .lineLimit(2...6)

          if !newSessionImages.isEmpty {
            attachmentStrip(newSessionImages) { removeId in
              newSessionImages.removeAll { $0.id == removeId }
            }
          }

          HStack(spacing: WorkspaceTheme.Spacing.x2) {
            Button {
              let picked = WorkspaceImageAttachment.pickImages(limit: max(1, 4 - newSessionImages.count))
              appendAttachments(picked, to: &newSessionImages)
            } label: {
              Label("Attach Photo", systemImage: "photo.on.rectangle")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isStartingSession || newSessionImages.count >= 4)

            Button {
              let pasted = WorkspaceImageAttachment.fromPasteboard(limit: max(1, 4 - newSessionImages.count))
              if pasted.isEmpty {
                newSessionNote = FleetNote(text: "Clipboard doesn't have an image.", isError: true)
              } else {
                appendAttachments(pasted, to: &newSessionImages)
              }
            } label: {
              Label("Paste Image", systemImage: "doc.on.clipboard")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isStartingSession || newSessionImages.count >= 4)

            Spacer()

            let canLaunch = !isStartingSession
              && (!newSessionPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !newSessionImages.isEmpty)
            WorkspaceActionButton(prominent: true, small: false) {
              Task {
                isStartingSession = true
                defer { isStartingSession = false }
                let rawWs = newSessionWorkspace.trimmingCharacters(in: .whitespacesAndNewlines)
                let chosenWs = rawWs.isEmpty ? defaultWorkspace : rawWs
                let matched = chosenWs.flatMap { name in
                  fleet.workspaces.first {
                    $0.name.caseInsensitiveCompare(name) == .orderedSame
                      || $0.id.caseInsensitiveCompare(name) == .orderedSame
                  }
                }
                let res = await fleet.startWorkspaceSession(
                  workspace: chosenWs,
                  cwd: matched?.defaultTarget?.cwd,
                  serverId: matched?.defaultTarget?.serverId,
                  title: newSessionTitle,
                  model: newSessionModel,
                  effort: newSessionEffort,
                  prompt: newSessionPrompt,
                  images: newSessionImages.map(\.fleetPayload)
                )
                newSessionNote = FleetNote(text: res.message, isError: !res.ok)
                if res.ok {
                  newSessionTitle = ""
                  newSessionPrompt = ""
                  newSessionImages = []
                  showNewSessionCreator = false
                  if let tk = res.threadKey {
                    expandedThreadKeys.insert(tk)
                  }
                }
              }
            } label: {
              if isStartingSession {
                HStack(spacing: 6) {
                  ProgressView().controlSize(.small)
                  Text("Starting…")
                }
              } else {
                Text("Start in Paseo")
              }
            }
            .disabled(!canLaunch)
          }
        }
        .padding(WorkspaceTheme.Spacing.x4)
        .workspaceCardSurface(cornerRadius: WorkspaceTheme.cardRadius)
      }
    }
  }

  @ViewBuilder
  private func projectStage(_ projName: String) -> some View {
    let projectSessionsAll = SupervisorChannelGrouping.filterSessions(sessionBriefs, project: projName)
    let overlaps = SupervisorChannelGrouping.calmOverlaps(for: projectSessionsAll)
    ForEach(overlaps) { ov in
      HStack(spacing: WorkspaceTheme.Spacing.x2) {
        Image(systemName: "info.circle.fill")
          .foregroundStyle(WorkspaceTheme.caution)
        Text(ov.detail)
          .font(WorkspaceTheme.Typography.caption.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
      }
      .padding(WorkspaceTheme.Spacing.x3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(WorkspaceTheme.caution.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(WorkspaceTheme.caution.opacity(0.28), lineWidth: 0.5)
      )
    }

    let matchingCards = decisionItems.filter {
      $0.project.caseInsensitiveCompare(projName) == .orderedSame
        && matchesQuery([$0.headline, $0.project])
    }
    if !matchingCards.isEmpty {
      Text("Waiting on You")
        .font(WorkspaceTheme.Typography.section)
        .foregroundStyle(WorkspaceTheme.ink)
      ForEach(matchingCards) { item in
        if let q = fleet.questions.first(where: { $0.id == item.id }) {
          questionCardView(q)
        }
      }
    }

    newSessionBar(defaultWorkspace: projName)

    let projSessions = projectSessionsAll.filter { matchesQuery([$0.title, $0.host, $0.cwd]) }
    if projSessions.isEmpty {
      Text("No loaded sessions in #\(projName). Ask Supervisor below to inspect or dispatch work.")
        .font(WorkspaceTheme.Typography.secondary)
        .foregroundStyle(WorkspaceTheme.muted)
        .padding(.vertical, WorkspaceTheme.Spacing.x4)
    } else {
      Text("Sessions (\(projSessions.count))")
        .font(WorkspaceTheme.Typography.section)
        .foregroundStyle(WorkspaceTheme.ink)
      ForEach(projSessions) { session in
        sessionCardView(session, showProjectTag: false)
      }
    }
  }

  // MARK: - Question & Session Cards

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

    return VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
      HStack(alignment: .top, spacing: WorkspaceTheme.Spacing.x2) {
        VStack(alignment: .leading, spacing: 3) {
          if q.risky { FleetRiskyLabel() }
          Text(q.title)
            .font(WorkspaceTheme.Typography.body.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.ink)
            .textSelection(.enabled)
          if let label = q.chatLabel ?? openChat?.label {
            Text(label)
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
              .lineLimit(1)
          }
        }
        Spacer()
        if let tk = q.threadKey, !tk.isEmpty {
          WorkspaceActionButton(small: true) {
            nav.selectedChannel = .sessions
            expandedThreadKeys.insert(tk)
            Task { await fleet.loadDetail(tk) }
          } label: {
            Text("View Session")
          }
          .help("Jump to this coding session's live transcript and composer")
        }
        if let chat = openChat, let btnTitle = FleetChatOpener.buttonTitle(chat) {
          WorkspaceActionButton(small: true) {
            fleet.openChat(chat)
          } label: {
            Text("\(btnTitle) ↗")
          }
          .help(chat.link == nil ? (chat.note ?? "Bring \(chat.appName ?? "app") forward") : "Open this thread directly")
        }
        WorkspaceActionButton(small: true) {
          toggleQuestionExpand(q)
        } label: {
          Label(isExpanded ? "Hide" : "Context", systemImage: isExpanded ? "chevron.up" : "chevron.down")
        }
      }

      if !q.body.isEmpty {
        WorkspaceMarkdownContent(
          blocks: WorkspaceMarkdownParser.parse(q.body),
          bodyFont: WorkspaceTheme.Typography.secondary,
          textColor: WorkspaceTheme.muted
        )
      }

      if let nextAction = q.plan?.nextAction?.trimmingCharacters(in: .whitespacesAndNewlines), !nextAction.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text(q.isClarificationQuestion ? "Question to unblock" : "Next step")
            .font(WorkspaceTheme.Typography.caption.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.live)
          WorkspaceMarkdownContent(
            blocks: WorkspaceMarkdownParser.parse(nextAction),
            bodyFont: WorkspaceTheme.Typography.secondary,
            textColor: WorkspaceTheme.ink
          )
          if let answered = q.clarificationAnswer?.trimmingCharacters(in: .whitespacesAndNewlines), !answered.isEmpty {
            Text("Your answer: \(answered)")
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
        .padding(WorkspaceTheme.Spacing.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WorkspaceTheme.live.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }

      if revealedPlanQuestionIDs.contains(q.id), let plan = q.plan {
        VStack(alignment: .leading, spacing: 6) {
          Text(plan.label ?? "Fix Plan")
            .font(WorkspaceTheme.Typography.caption.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.ink)
          if let acceptance = plan.acceptance?.trimmingCharacters(in: .whitespacesAndNewlines), !acceptance.isEmpty {
            Text("Acceptance: \(acceptance)")
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          }
          if let issueTitle = plan.issueDraft?.title?.trimmingCharacters(in: .whitespacesAndNewlines), !issueTitle.isEmpty {
            Text("Issue: \(issueTitle)")
              .font(WorkspaceTheme.Typography.caption.weight(.medium))
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
        .padding(WorkspaceTheme.Spacing.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WorkspaceTheme.surfaceFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }

      HStack(spacing: WorkspaceTheme.Spacing.x2) {
        ForEach(Array(q.tappableOptions.prefix(4).enumerated()), id: \.offset) { index, opt in
          let handlesLocally = opt == "Answer question" || (opt == "Review plan" && q.plan != nil)
          WorkspaceActionButton(prominent: index == 0 && !q.risky, small: true) {
            if opt == "Answer question" {
              expandedQuestionIDs.insert(q.id)
              focusedThreadSlot = slotKey
            } else if opt == "Review plan", q.plan != nil {
              if revealedPlanQuestionIDs.contains(q.id) {
                revealedPlanQuestionIDs.remove(q.id)
              } else {
                revealedPlanQuestionIDs.insert(q.id)
              }
            } else {
              Task { await fleet.answer(q, option: opt) }
            }
          } label: {
            Text(q.label(for: opt))
          }
          .disabled(busy && !handlesLocally)
        }

        Button("Ask Supervisor") {
          composerText = "About \"\(q.title)\": "
          inlineChatOpen = true
          composerFocused = true
        }
        .buttonStyle(.borderless)
        .font(WorkspaceTheme.Typography.caption.weight(.medium))
        .foregroundStyle(WorkspaceTheme.live)

        Spacer()

        Button("Dismiss") {
          Task { await fleet.dismiss(q) }
        }
        .buttonStyle(.borderless)
        .font(WorkspaceTheme.Typography.caption)
        .foregroundStyle(WorkspaceTheme.muted)
        .disabled(busy)
      }

      if let note = fleet.notes[q.id] {
        FleetNoteRow(note: note) { fleet.clearNote(q.id) }
      }

      if isExpanded {
        WorkspaceHairline(leadingInset: 0)
        if let context = q.displayAskContext, !context.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("Agent context")
              .font(WorkspaceTheme.Typography.caption.weight(.semibold))
              .foregroundStyle(WorkspaceTheme.muted)
            WorkspaceMarkdownContent(
              blocks: WorkspaceMarkdownParser.parse(context),
              bodyFont: WorkspaceTheme.Typography.secondary,
              textColor: WorkspaceTheme.ink
            )
              .padding(WorkspaceTheme.Spacing.x3)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(WorkspaceTheme.surfaceFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          }
        }

        if let tk = q.threadKey {
          let thread = fleet.thread(tk)
          let summary = FleetThreadSummary(thread: thread, detail: detail)
          FleetThreadLines(summary: summary, showsExcerpt: detail?.conversation == nil && (q.displayAskContext?.isEmpty ?? true))
          FleetConversationList(conversation: detail?.conversation, loading: fleet.detailLoading.contains(tk))
        } else {
          Text("Reply directly below to answer through Supervisor.")
            .font(WorkspaceTheme.Typography.caption)
            .foregroundStyle(WorkspaceTheme.muted)
        }

        directThreadComposer(
          slotKey: slotKey,
          placeholder: q.isClarificationQuestion
            ? "Type your answer to unblock this plan…"
            : "Reply directly to this session…",
          onRefresh: q.threadKey.map { tk in { Task { await fleet.loadDetail(tk) } } }
        ) { text, payloadImages in
          await fleet.sendWorkspaceQuestionReply(q, message: text, images: payloadImages)
        }
      }
    }
    .padding(WorkspaceTheme.Spacing.x4)
    .workspaceCardSurface(cornerRadius: WorkspaceTheme.cardRadius)
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
    let isRunning = session.state == "running"

    return VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
      HStack(spacing: WorkspaceTheme.Spacing.x2) {
        Button {
          toggleThreadExpand(session.id)
        } label: {
          HStack(spacing: WorkspaceTheme.Spacing.x3) {
            Circle()
              .fill(isRunning ? WorkspaceTheme.live : WorkspaceTheme.muted.opacity(0.4))
              .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 6) {
                Text(session.title)
                  .font(WorkspaceTheme.Typography.body.weight(.semibold))
                  .foregroundStyle(WorkspaceTheme.ink)
                if showProjectTag {
                  Text("#\(session.project)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(WorkspaceTheme.muted)
                }
              }
              Text([session.state, session.host, session.cwd, thread?.prShortRef].compactMap { $0 }.joined(separator: " · "))
                .font(WorkspaceTheme.Typography.dataMono)
                .foregroundStyle(WorkspaceTheme.muted)
                .lineLimit(1)
            }
            Spacer()
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if let chat = openChat, let btnTitle = FleetChatOpener.buttonTitle(chat) {
          WorkspaceActionButton(small: true) {
            fleet.openChat(chat)
          } label: {
            Text("\(btnTitle) ↗")
          }
        }
        WorkspaceActionButton(small: true) {
          toggleThreadExpand(session.id)
        } label: {
          Label(isExpanded ? "Hide" : "Context", systemImage: isExpanded ? "chevron.up" : "chevron.down")
        }
      }

      if isExpanded {
        WorkspaceHairline(leadingInset: 0)
        FleetThreadLines(summary: summary, showsExcerpt: detail?.conversation == nil)
        FleetConversationList(conversation: detail?.conversation, loading: fleet.detailLoading.contains(session.id))

        HStack(spacing: WorkspaceTheme.Spacing.x2) {
          if group == "push", !summary.muted, summary.pushMessage != nil {
            WorkspaceActionButton(prominent: true, small: true) {
              Task { await fleet.pushNow(session.id) }
            } label: {
              Text("Push now")
            }
            .disabled(busy || thread?.pushing == true)
          }
          WorkspaceActionButton(small: true) {
            Task { summary.muted ? await fleet.unmute(session.id) : await fleet.mute(session.id) }
          } label: {
            Text(summary.muted ? "Unmute" : "Mute 24h")
          }
          .disabled(busy)

          Button("Ask Supervisor") {
            composerText = "Check on \"\(session.title)\" (\(session.id)): "
            inlineChatOpen = true
            composerFocused = true
          }
          .buttonStyle(.borderless)
          .font(WorkspaceTheme.Typography.caption.weight(.medium))
          .foregroundStyle(WorkspaceTheme.live)

          Spacer()
          if busy { ProgressView().controlSize(.small) }
        }

        if let note = fleet.threadNotes[session.id] {
          FleetNoteRow(note: note) { fleet.clearThreadNote(session.id) }
        }

        directThreadComposer(
          slotKey: slotKey,
          placeholder: "Reply directly to \(session.title)…",
          onRefresh: { Task { await fleet.loadDetail(session.id) } }
        ) { text, payloadImages in
          await fleet.sendWorkspaceThreadReply(threadKey: session.id, message: text, images: payloadImages)
        }
      }
    }
    .padding(WorkspaceTheme.Spacing.x4)
    .workspaceCardSurface(cornerRadius: WorkspaceTheme.cardRadius)
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
    let queued = threadReplyQueues[slotKey] ?? []
    let isBusy = threadReplyBusy.contains(slotKey)
    let hasTextOrPhoto = !(threadReplyText[slotKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attached.isEmpty

    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
      if let note = threadReplyFeedback[slotKey] {
        FleetNoteRow(note: note) { threadReplyFeedback[slotKey] = nil }
      }
      if !queued.isEmpty {
        queuedMessagesTray(
          items: queued,
          onEdit: { id in
            guard var list = threadReplyQueues[slotKey],
                  let idx = list.firstIndex(where: { $0.id == id }) else { return }
            let popped = list.remove(at: idx)
            threadReplyQueues[slotKey] = list.isEmpty ? nil : list
            if (threadReplyText[slotKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              threadReplyText[slotKey] = popped.text
            } else {
              threadReplyText[slotKey] = (threadReplyText[slotKey] ?? "") + "\n" + popped.text
            }
            if !popped.attachments.isEmpty {
              appendAttachments(popped.attachments, to: &threadReplyImages[slotKey, default: []])
            }
            focusedThreadSlot = slotKey
          },
          onRemove: { id in
            guard var list = threadReplyQueues[slotKey] else { return }
            list.removeAll { $0.id == id }
            threadReplyQueues[slotKey] = list.isEmpty ? nil : list
          }
        )
      }
      if !attached.isEmpty {
        attachmentStrip(attached) { removeId in
          threadReplyImages[slotKey] = (threadReplyImages[slotKey] ?? []).filter { $0.id != removeId }
        }
      }
      HStack(alignment: .center, spacing: 8) {
        let attachPopoverBinding = Binding<Bool>(
          get: { threadAttachPopoverSlot == slotKey },
          set: { threadAttachPopoverSlot = $0 ? slotKey : nil }
        )
        Button {
          threadAttachPopoverSlot = (threadAttachPopoverSlot == slotKey) ? nil : slotKey
        } label: {
          Image(systemName: "plus")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(attached.isEmpty ? WorkspaceTheme.ink.opacity(0.75) : WorkspaceTheme.live)
            .frame(width: 28, height: 28)
            .background(
              (attached.isEmpty ? WorkspaceTheme.muted : WorkspaceTheme.live).opacity(0.14),
              in: Circle()
            )
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(attached.count >= 4)
        .help("Attach or paste up to 4 images")
        .popover(isPresented: attachPopoverBinding, arrowEdge: .top) {
          VStack(alignment: .leading, spacing: 4) {
            Button {
              threadAttachPopoverSlot = nil
              let picked = WorkspaceImageAttachment.pickImages(limit: max(1, 4 - attached.count))
              appendAttachments(picked, to: &threadReplyImages[slotKey, default: []])
            } label: {
              Label("Photo or Screenshot…", systemImage: "photo.on.rectangle")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            Button {
              threadAttachPopoverSlot = nil
              let pasted = WorkspaceImageAttachment.fromPasteboard(limit: max(1, 4 - attached.count))
              if pasted.isEmpty {
                threadReplyFeedback[slotKey] = FleetNote(text: "Clipboard doesn't have an image.", isError: true)
              } else {
                threadReplyFeedback[slotKey] = nil
                appendAttachments(pasted, to: &threadReplyImages[slotKey, default: []])
              }
            } label: {
              Label("Paste Image from Clipboard", systemImage: "doc.on.clipboard")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
          }
          .padding(6)
          .frame(width: 230)
        }

        TextField(placeholder, text: draft, axis: .vertical)
          .textFieldStyle(.plain)
          .font(WorkspaceTheme.Typography.secondary)
          .lineLimit(1...4)
          .focused($focusedThreadSlot, equals: slotKey)
          .onChange(of: draft.wrappedValue) { _, newValue in
            let remaining = max(0, 4 - (threadReplyImages[slotKey]?.count ?? 0))
            guard remaining > 0 else { return }
            let extracted = WorkspaceImageAttachment.extractInlineLocalImages(from: newValue, limit: remaining)
            if !extracted.attachments.isEmpty {
              threadReplyText[slotKey] = extracted.cleanedText
              appendAttachments(extracted.attachments, to: &threadReplyImages[slotKey, default: []])
              threadReplyFeedback[slotKey] = nil
            }
          }
          .onSubmit {
            sendDirectReply(slotKey: slotKey, onSubmitReply: onSubmitReply)
          }

        if let onRefresh {
          Button {
            onRefresh()
          } label: {
            Image(systemName: "arrow.clockwise")
              .font(.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          }
          .buttonStyle(.plain)
          .help("Reload thread transcript")
        }

        Button {
          sendDirectReply(slotKey: slotKey, onSubmitReply: onSubmitReply)
        } label: {
          if isBusy && !hasTextOrPhoto {
            ProgressView().controlSize(.small)
              .frame(width: 26, height: 26)
          } else {
            Image(systemName: "arrow.up")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(.white)
              .frame(width: 26, height: 26)
              .background(
                hasTextOrPhoto ? WorkspaceTheme.live : WorkspaceTheme.muted.opacity(0.35),
                in: Circle()
              )
          }
        }
        .buttonStyle(.plain)
        .disabled(!hasTextOrPhoto)
        .help(isBusy ? "Queue next reply" : "Send reply")
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .workspaceGlassCapsule(cornerRadius: 18, focused: focusedThreadSlot == slotKey)
      .onDrop(of: [.fileURL, .image], isTargeted: nil) { providers in
        Task {
          let currentCount = await MainActor.run { threadReplyImages[slotKey]?.count ?? 0 }
          let dropped = await WorkspaceImageAttachment.fromDropProviders(
            providers,
            limit: max(1, 4 - currentCount)
          )
          await MainActor.run {
            if !dropped.isEmpty {
              threadReplyFeedback[slotKey] = nil
              appendAttachments(dropped, to: &threadReplyImages[slotKey, default: []])
            }
          }
        }
        return true
      }
    }
  }

  private func sendDirectReply(
    slotKey: String,
    onSubmitReply: @escaping (String, [[String: Any]]) async -> FleetNote
  ) {
    var rawText = threadReplyText[slotKey] ?? ""
    var imgs = threadReplyImages[slotKey] ?? []
    let extracted = WorkspaceImageAttachment.extractInlineLocalImages(from: rawText, limit: max(0, 4 - imgs.count))
    if !extracted.attachments.isEmpty {
      rawText = extracted.cleanedText
      appendAttachments(extracted.attachments, to: &imgs)
    }
    let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || !imgs.isEmpty else { return }
    let effectiveText = text.isEmpty ? "Please inspect the attached image(s)." : text
    threadReplyText[slotKey] = ""
    threadReplyImages[slotKey] = []
    threadReplyFeedback[slotKey] = nil

    if threadReplyBusy.contains(slotKey) {
      threadReplyQueues[slotKey, default: []].append(
        QueuedSupervisorMessage(id: "tq-\(UUID().uuidString)", text: effectiveText, focusedCardId: nil, attachments: imgs)
      )
      return
    }

    threadReplyBusy.insert(slotKey)
    Task {
      defer { threadReplyBusy.remove(slotKey) }
      var currentText = effectiveText
      var currentImgs = imgs
      var isInitial = true
      while true {
        let note = await onSubmitReply(currentText, currentImgs.map(\.fleetPayload))
        threadReplyFeedback[slotKey] = note
        if isInitial, note.isError {
          if (threadReplyText[slotKey] ?? "").isEmpty { threadReplyText[slotKey] = currentText }
          if (threadReplyImages[slotKey] ?? []).isEmpty && !currentImgs.isEmpty { threadReplyImages[slotKey] = currentImgs }
        }
        isInitial = false
        guard var queue = threadReplyQueues[slotKey], !queue.isEmpty else { break }
        let next = queue.removeFirst()
        threadReplyQueues[slotKey] = queue.isEmpty ? nil : queue
        currentText = next.text
        currentImgs = next.attachments
      }
    }
  }

  @ViewBuilder
  private func queuedMessagesTray(
    items: [QueuedSupervisorMessage],
    onEdit: @escaping (String) -> Void,
    onRemove: @escaping (String) -> Void
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Queued (\(items.count))")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(WorkspaceTheme.muted)
      ForEach(items) { item in
        HStack(spacing: 8) {
          Image(systemName: "clock")
            .font(.caption2)
            .foregroundStyle(WorkspaceTheme.live)
          Text(item.text)
            .font(WorkspaceTheme.Typography.caption)
            .foregroundStyle(WorkspaceTheme.ink)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          if !item.attachments.isEmpty {
            Text("\(item.attachments.count) img")
              .font(.caption2)
              .foregroundStyle(WorkspaceTheme.muted)
          }
          Button("Edit") { onEdit(item.id) }
            .buttonStyle(.borderless)
            .font(.caption2.weight(.medium))
            .foregroundStyle(WorkspaceTheme.live)
          Button { onRemove(item.id) } label: {
            Image(systemName: "xmark")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(WorkspaceTheme.muted)
          }
          .buttonStyle(.plain)
          .help("Remove from queue")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(WorkspaceTheme.surfaceFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
    }
  }

  // MARK: - Shared Supervisor Messages (DESIGN.md Alignment + Markdown)

  @ViewBuilder
  private func supervisorMessagesView(_ messages: [SyncedSupervisorMessage]) -> some View {
    let lastAssistantId = messages.last(where: { $0.role != "user" })?.id
    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
      ForEach(messages) { msg in
        if msg.role == "user" {
          userBubbleRow(msg)
        } else {
          assistantDocumentRow(msg, showsActions: msg.id == lastAssistantId && !supervisor.isSending)
        }
      }

      if supervisor.isSending {
        let liveText = supervisor.streamingReplyText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
          if !liveText.isEmpty {
            WorkspaceMarkdownContent(blocks: WorkspaceMarkdownParser.parse(supervisor.streamingReplyText ?? liveText))
          }
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text(sendingStageLabel)
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func userBubbleRow(_ msg: SyncedSupervisorMessage) -> some View {
    VStack(alignment: .trailing, spacing: WorkspaceTheme.Spacing.x1) {
      if let src = msg.sourceName?.trimmingCharacters(in: .whitespacesAndNewlines),
         !src.isEmpty,
         src.caseInsensitiveCompare("Mac") != .orderedSame {
        Text("From \(src)")
          .font(WorkspaceTheme.Typography.caption)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      let thumbs = msg.thumbnailImageData
      if !thumbs.isEmpty {
        HStack(spacing: 8) {
          ForEach(Array(thumbs.enumerated()), id: \.offset) { _, data in
            if let nsImg = NSImage(data: data) {
              Image(nsImage: nsImg)
                .resizable()
                .scaledToFill()
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(WorkspaceTheme.edge, lineWidth: 0.5)
                )
            }
          }
        }
      }
      Text(msg.text)
        .font(WorkspaceTheme.Typography.chatBody)
        .foregroundStyle(WorkspaceTheme.ink)
        .textSelection(.enabled)
        .padding(.horizontal, WorkspaceTheme.Spacing.x4)
        .padding(.vertical, WorkspaceTheme.Spacing.x3)
        .background(
          WorkspaceTheme.surfaceFill,
          in: RoundedRectangle(cornerRadius: WorkspaceTheme.bubbleRadius, style: .continuous)
        )
        .frame(maxWidth: 520, alignment: .trailing)
        .contextMenu {
          Button("Copy") { copyText(msg.text) }
        }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }

  private func assistantDocumentRow(_ msg: SyncedSupervisorMessage, showsActions: Bool) -> some View {
    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
      WorkspaceMarkdownContent(blocks: WorkspaceMarkdownParser.parse(msg.text))
      if showsActions {
        HStack(spacing: 8) {
          Button {
            copyText(msg.text)
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          }
          .buttonStyle(.plain)
        }
        .padding(.top, 2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contextMenu {
      Button("Copy") { copyText(msg.text) }
    }
  }

  private func copyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  private var sendingStageLabel: String {
    switch supervisor.progressStage {
    case "queued": return "Queued…"
    case "routing": return "Choosing the right agent…"
    case "accepted": return "Request saved…"
    case "context": return "Gathering context…"
    case "reasoning", "model": return "Thinking…"
    case "tool": return "Using tools…"
    case "saving": return "Saving answer…"
    default: return "Thinking…"
    }
  }

  // MARK: - Floating Liquid Glass Bottom Dock & Inline Supervisor Sheet

  private var floatingBottomDock: some View {
    VStack(spacing: WorkspaceTheme.Spacing.x2) {
      if activeChannel != .general && inlineChatOpen {
        inlineSupervisorSheet
      }

      if let err = supervisor.lastError {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.alert)
          Text(err)
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.alert)
            .lineLimit(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
          Button {
            supervisor.clearError()
          } label: {
            Image(systemName: "xmark")
              .font(.caption2)
              .foregroundStyle(WorkspaceTheme.muted)
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .workspaceCardSurface(cornerRadius: 12)
      }

      if let note = composerStatusNote {
        HStack {
          Text(note)
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.caution)
          Spacer()
        }
        .padding(.horizontal, 10)
      }

      if !supervisor.queuedMessages.isEmpty {
        queuedMessagesTray(
          items: supervisor.queuedMessages,
          onEdit: { id in
            guard let popped = supervisor.popQueuedForEdit(id: id) else { return }
            if composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              composerText = popped.text
            } else {
              composerText += "\n" + popped.text
            }
            if !popped.attachments.isEmpty {
              appendAttachments(popped.attachments, to: &composerImages)
            }
            composerFocused = true
          },
          onRemove: { id in
            supervisor.removeQueued(id: id)
          }
        )
      }

      if !composerImages.isEmpty {
        attachmentStrip(composerImages) { removeId in
          composerImages.removeAll { $0.id == removeId }
        }
      }

      floatingPillBar

      Text(activeTargetLabel)
        .font(.caption2)
        .foregroundStyle(WorkspaceTheme.muted)
    }
    .frame(maxWidth: 740)
    .padding(.horizontal, WorkspaceTheme.Spacing.x5)
    .padding(.bottom, WorkspaceTheme.Spacing.x3)
    .padding(.top, 6)
    .frame(maxWidth: .infinity)
  }

  private var floatingPillBar: some View {
    let trimmed = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
    let canSend = !trimmed.isEmpty || !composerImages.isEmpty
    let isMultiline = composerText.contains("\n") || composerText.count > 72

    return HStack(alignment: isMultiline ? .bottom : .center, spacing: 8) {
      Button {
        showAttachPopover.toggle()
      } label: {
        Image(systemName: "plus")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(composerImages.isEmpty ? WorkspaceTheme.ink.opacity(0.75) : WorkspaceTheme.live)
          .frame(width: 32, height: 32)
          .background(
            (composerImages.isEmpty ? WorkspaceTheme.muted : WorkspaceTheme.live).opacity(0.14),
            in: Circle()
          )
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .disabled(composerImages.count >= 4)
      .help("Attach or paste up to 4 images")
      .popover(isPresented: $showAttachPopover, arrowEdge: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Button {
            showAttachPopover = false
            composerStatusNote = nil
            let picked = WorkspaceImageAttachment.pickImages(limit: max(1, 4 - composerImages.count))
            appendAttachments(picked, to: &composerImages)
          } label: {
            Label("Photo or Screenshot…", systemImage: "photo.on.rectangle")
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
          }
          .buttonStyle(.plain)

          Button {
            showAttachPopover = false
            let pasted = WorkspaceImageAttachment.fromPasteboard(limit: max(1, 4 - composerImages.count))
            if pasted.isEmpty {
              composerStatusNote = "Clipboard has no image to attach."
            } else {
              composerStatusNote = nil
              appendAttachments(pasted, to: &composerImages)
            }
          } label: {
            Label("Paste Image from Clipboard", systemImage: "doc.on.clipboard")
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
          }
          .buttonStyle(.plain)
        }
        .padding(6)
        .frame(width: 230)
      }

      TextField(composerPlaceholder, text: $composerText, axis: .vertical)
        .textFieldStyle(.plain)
        .font(WorkspaceTheme.Typography.chatBody)
        .lineLimit(1...6)
        .focused($composerFocused)
        .padding(.vertical, 7)
        .onChange(of: composerText) { _, newValue in
          let remaining = max(0, 4 - composerImages.count)
          guard remaining > 0 else { return }
          let extracted = WorkspaceImageAttachment.extractInlineLocalImages(from: newValue, limit: remaining)
          if !extracted.attachments.isEmpty {
            composerText = extracted.cleanedText
            composerStatusNote = nil
            appendAttachments(extracted.attachments, to: &composerImages)
          }
        }
        .onSubmit {
          sendFromWorkspace()
        }

      if activeChannel != .general {
        Button {
          withAnimation(.easeOut(duration: 0.16)) {
            inlineChatOpen.toggle()
          }
        } label: {
          HStack(spacing: 4) {
            Image(systemName: "bubble.left.and.bubble.right")
              .font(.caption.weight(.semibold))
            Text("\(supervisor.messages.count)")
              .font(.caption2.weight(.semibold))
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 6)
          .background(
            (inlineChatOpen ? WorkspaceTheme.live : WorkspaceTheme.muted).opacity(0.14),
            in: Capsule()
          )
          .foregroundStyle(inlineChatOpen ? WorkspaceTheme.live : WorkspaceTheme.muted)
        }
        .buttonStyle(.plain)
        .help(inlineChatOpen ? "Minimize Supervisor chat drawer" : "Show Supervisor chat history")
      }

      Button {
        sendFromWorkspace()
      } label: {
        Group {
          if supervisor.isSending && !canSend {
            ProgressView()
              .controlSize(.small)
          } else {
            Image(systemName: "arrow.up")
              .font(.system(size: 14, weight: .bold))
              .foregroundStyle(.white)
          }
        }
        .frame(width: 32, height: 32)
        .background(
          canSend ? WorkspaceTheme.live : WorkspaceTheme.muted.opacity(0.32),
          in: Circle()
        )
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .help(supervisor.isSending ? "Queue message for Supervisor" : "Send to Supervisor")
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .workspaceGlassCapsule(cornerRadius: WorkspaceTheme.pillRadius, focused: composerFocused)
    .overlay(
      RoundedRectangle(cornerRadius: WorkspaceTheme.pillRadius, style: .continuous)
        .strokeBorder(isDropTargeted ? WorkspaceTheme.live : Color.clear, lineWidth: 2)
    )
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

  private var inlineSupervisorSheet: some View {
    VStack(spacing: 0) {
      HStack {
        Label("Supervisor Chat (\(supervisor.messages.count))", systemImage: "bubble.left.and.bubble.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(WorkspaceTheme.muted)
        Spacer()
        Button("Full General ↗") {
          nav.selectedChannel = .general
        }
        .buttonStyle(.borderless)
        .font(.caption)
        Button("Minimize") {
          inlineChatOpen = false
        }
        .buttonStyle(.borderless)
        .font(.caption)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)

      WorkspaceHairline(leadingInset: 0)

      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          if supervisor.messages.isEmpty {
            Text("No messages yet — ask anything or drop screenshots below.")
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          } else {
            supervisorMessagesView(Array(supervisor.messages.suffix(12)))
          }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 220)
    }
    .workspaceCardSurface(cornerRadius: 18)
  }

  private func attachmentStrip(_ items: [WorkspaceImageAttachment], onRemove: @escaping (String) -> Void) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(items) { item in
          ZStack(alignment: .topTrailing) {
            Image(nsImage: item.preview)
              .resizable()
              .scaledToFill()
              .frame(width: 64, height: 64)
              .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .strokeBorder(WorkspaceTheme.edge, lineWidth: 0.5)
              )
            Button {
              onRemove(item.id)
            } label: {
              Image(systemName: "xmark.circle.fill")
                .font(.system(size: 15))
                .foregroundStyle(.white, .black.opacity(0.75))
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

  private var composerPlaceholder: String {
    switch activeChannel {
    case .general:
      return "Message Supervisor (drop or attach screenshots)…"
    case let .project(name):
      return "Ask Supervisor about #\(name)…"
    case .needsYou, .tasks, .sessions:
      return "Ask Supervisor…"
    }
  }

  private func sendFromWorkspace() {
    var rawDraft = composerText
    var imgs = composerImages
    let extracted = WorkspaceImageAttachment.extractInlineLocalImages(from: rawDraft, limit: max(0, 4 - imgs.count))
    if !extracted.attachments.isEmpty {
      rawDraft = extracted.cleanedText
      appendAttachments(extracted.attachments, to: &imgs)
    }
    let raw = rawDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty || !imgs.isEmpty else { return }
    let textToSend: String
    if case let .project(projName) = activeChannel {
      textToSend = raw.isEmpty ? "[\(projName)] Please inspect the attached screenshot(s)." : "[\(projName)] \(raw)"
      inlineChatOpen = true
    } else if activeChannel != .general {
      textToSend = raw.isEmpty ? "Please inspect the attached screenshot(s)." : raw
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

  private func installPasteMonitor() {
    guard pasteKeyMonitor == nil else { return }
    pasteKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      MainActor.assumeIsolated {
        handleCommandVPaste(event)
      }
    }
  }

  private func removePasteMonitor() {
    if let monitor = pasteKeyMonitor {
      NSEvent.removeMonitor(monitor)
      pasteKeyMonitor = nil
    }
  }

  @MainActor
  private func handleCommandVPaste(_ event: NSEvent) -> NSEvent? {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard flags == .command,
          event.charactersIgnoringModifiers?.lowercased() == "v",
          let win = hostWindow,
          event.window === win else {
      return event
    }
    if let slot = focusedThreadSlot {
      let current = threadReplyImages[slot] ?? []
      guard current.count < 4 else { return event }
      let pasted = WorkspaceImageAttachment.pasteboardImagesForCommandV(limit: 4 - current.count)
      guard !pasted.isEmpty else { return event }
      appendAttachments(pasted, to: &threadReplyImages[slot, default: []])
      threadReplyFeedback[slot] = nil
      return nil
    }
    guard composerImages.count < 4 else { return event }
    let pasted = WorkspaceImageAttachment.pasteboardImagesForCommandV(limit: 4 - composerImages.count)
    guard !pasted.isEmpty else { return event }
    appendAttachments(pasted, to: &composerImages)
    composerStatusNote = nil
    composerFocused = true
    return nil
  }
}

private struct WorkspaceWindowAccessor: NSViewRepresentable {
  @Binding var window: NSWindow?

  func makeNSView(context: Context) -> NSView {
    let view = NSView(frame: .zero)
    DispatchQueue.main.async {
      if self.window !== view.window {
        self.window = view.window
      }
    }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async {
      if self.window !== nsView.window {
        self.window = nsView.window
      }
    }
  }
}
