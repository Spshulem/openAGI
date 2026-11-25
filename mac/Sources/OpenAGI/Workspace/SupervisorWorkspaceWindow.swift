import AppKit
import SupervisorChannelsKit
import SwiftUI
import UniformTypeIdentifiers

enum WorkspaceChannel: Hashable {
  case general
  case needsYou
  case tasks
  case sessions
  case activity
  case project(String)
  case subchannel(project: String, subchannel: String)
}

enum WorkspaceComposerMode: String, CaseIterable, Identifiable {
  case chat
  case startTask
  var id: String { rawValue }
  var label: String { self == .chat ? "Chat" : "Start Task" }
}

@MainActor
final class SupervisorWorkspaceNavigation: ObservableObject {
  @Published var selectedChannel: WorkspaceChannel? = .general
  /// A Needs You question to select and open in the inspector (a deep link
  /// or the review snapshot); the workspace clears it once opened.
  @Published var requestedQuestionID: String? = nil
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
      .frame(minWidth: 860, minHeight: 580)
    let host = NSHostingController(rootView: root)
    let win = NSWindow(contentViewController: host)
    win.title = "OpenAGI"
    win.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    win.toolbarStyle = .unified
    win.titleVisibility = .visible
    win.setContentSize(NSSize(width: 1220, height: 760))
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
  /// Observed so the composer's busy line follows the tray menu at once.
  @AppStorage(BusySendBehavior.defaultsKey) private var busySendPreference = BusySendBehavior.default.rawValue
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

  @State private var showNeedsYouUpdates = false
  /// Sidebar projects the owner opened or closed by hand; the rest follow
  /// the default (open when something waits on you or it is selected).
  @State private var expandedProjects: Set<String> = []
  @State private var collapsedProjects: Set<String> = []
  @FocusState private var needsYouListFocused: Bool
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
  @State private var newSessionModel = "gpt-6.2-sol"
  @State private var newSessionEffort = "medium"
  @State private var newSessionTitle = ""
  @State private var newSessionPrompt = ""
  @State private var newSessionImages: [WorkspaceImageAttachment] = []
  @State private var isStartingSession = false
  @State private var newSessionNote: FleetNote? = nil

  @State private var inspectorSelection: WorkspaceInspectorSelection? = nil
  @State private var isInspectorOpen: Bool = false
  @State private var selectedTaskStateFilter: SupervisorBoardTaskState = .all
  @State private var activeLabelFilters: Set<String> = []
  @State private var composerMode: WorkspaceComposerMode = .chat
  @State private var composerClaimInPaseo: Bool = true
  @State private var claimingTaskIDs: Set<String> = []
  @State private var showMoreProjects: Bool = false
  @State private var showNewProjectPopover: Bool = false
  @State private var newProjectName: String = ""
  @State private var newProjectTheme: String = ""
  @State private var newProjectAlias: String = ""
  @State private var organizingSessionKey: String? = nil
  @State private var organizeProjectDraft: String = ""
  @State private var organizeThemeDraft: String = ""

  private var activeChannel: WorkspaceChannel {
    nav.selectedChannel ?? .general
  }

  /// What Needs You shows: actionable decisions plus tool approvals. FYIs
  /// and completions (needsYou false) are listed apart and never counted.
  private var waitingTotal: Int {
    SupervisorAttentionCounting.needsYouTotal(
      needsYouFlags: fleet.questions.map(\.needsYou),
      pendingApprovals: approvals.items.count
    )
  }

  private var runningCount: Int {
    fleet.threads.filter { $0.state == "running" }.count
  }

  private var decisionItems: [SupervisorDecisionItem] {
    let byKey = Dictionary(fleet.threads.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    return fleet.questions.filter { SupervisorAttentionCounting.isActionable(needsYou: $0.needsYou) }.map { q in
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
        subchannel: q.subchannel ?? linked?.subchannel,
        headline: q.decisionHeadline ?? q.title,
        fact: q.decisionFact,
        kindLabel: q.kind ?? "Needs you",
        risky: q.risky,
        noticedAtISO: q.askedTime
      )
    }
  }

  private var sessionBriefs: [SupervisorSessionBrief] {
    var hierarchyMetaByKey: [String: (project: String, theme: String?)] = [:]
    for proj in fleet.hierarchyProjects {
      for th in proj.themes {
        let cleanTheme = th.name.caseInsensitiveCompare("General & Standalone") == .orderedSame ? nil : th.name
        for s in th.sessions {
          hierarchyMetaByKey[s.key] = (proj.name, cleanTheme)
        }
      }
    }

    var seen = Set<String>()
    var out: [SupervisorSessionBrief] = fleet.threads.map { t in
      seen.insert(t.key)
      let hMeta = hierarchyMetaByKey[t.key]
      let proj = SupervisorChannelGrouping.normalizeProject(
        explicit: t.project ?? hMeta?.project,
        repo: t.repo,
        workspace: t.workspace,
        cwd: t.cwd
      )
      let sub = t.subchannel ?? hMeta?.theme.map { "\(proj)/\($0)" }
      return SupervisorSessionBrief(
        id: t.key,
        project: proj,
        subchannel: sub,
        theme: hMeta?.theme ?? "General",
        title: t.name,
        host: t.host,
        cwd: t.cwd,
        state: t.state ?? "idle",
        lastActivityISO: t.lastActivityAt
      )
    }

    for proj in fleet.hierarchyProjects {
      let normProj = SupervisorChannelGrouping.normalizeProject(explicit: proj.name, repo: proj.repo)
      for th in proj.themes {
        let cleanTheme = th.name.caseInsensitiveCompare("General & Standalone") == .orderedSame ? nil : th.name
        let sub = cleanTheme.map { "\(normProj)/\($0)" }
        for s in th.sessions where seen.insert(s.key).inserted {
          out.append(SupervisorSessionBrief(
            id: s.key,
            project: normProj,
            subchannel: sub,
            theme: cleanTheme ?? "General",
            title: s.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? s.title! : s.key,
            host: s.host,
            cwd: s.cwd,
            state: s.state ?? "idle",
            lastActivityISO: s.lastActivityAt
          ))
        }
      }
    }
    return out
  }

  private var projectChannels: [SupervisorChannelSummary] {
    var base = SupervisorChannelGrouping.projectChannels(from: decisionItems, sessions: sessionBriefs)
    var seen = Set(base.map { projectName(for: $0).lowercased() })
    for proj in fleet.hierarchyProjects {
      let norm = SupervisorChannelGrouping.normalizeProject(explicit: proj.name, repo: proj.repo)
      let key = norm.lowercased()
      guard key != "general", seen.insert(key).inserted else { continue }
      base.append(SupervisorChannelSummary(
        id: "project:\(key)",
        kind: .project(norm),
        displayName: "# \(norm)",
        // Decisions are counted from the open questions above, the same
        // ones Needs You lists; a project known only from the hierarchy has
        // none of them (its own needsYouCount can include FYIs).
        waitingCount: 0,
        runningCount: proj.counts?.running ?? 0,
        totalCount: proj.counts?.total ?? 0
      ))
    }
    return base
  }

  private func mergedSubchannels(forProject projName: String) -> [SupervisorSubchannelSummary] {
    var base = SupervisorChannelGrouping.subchannels(forProject: projName, from: decisionItems, sessions: sessionBriefs)
    var seen = Set(base.map { $0.displayName.lowercased() })
    if let hProj = fleet.hierarchyProjects.first(where: {
      $0.name.caseInsensitiveCompare(projName) == .orderedSame
        || SupervisorChannelGrouping.normalizeProject(explicit: $0.name, repo: $0.repo).caseInsensitiveCompare(projName) == .orderedSame
    }) {
      for th in hProj.themes {
        guard th.name.caseInsensitiveCompare("General & Standalone") != .orderedSame,
              th.name.caseInsensitiveCompare(projName) != .orderedSame else { continue }
        let display = "/\(th.name)"
        guard seen.insert(display.lowercased()).inserted else { continue }
        base.append(SupervisorSubchannelSummary(
          id: "subchannel:\(projName.lowercased())/\(th.id.lowercased())",
          project: projName,
          subchannel: "\(projName)/\(th.name)",
          displayName: display,
          waitingCount: 0,
          runningCount: th.counts?.running ?? 0,
          totalCount: th.counts?.total ?? 0
        ))
      }
    }
    return base
  }

  private var navigationTitleText: String {
    switch activeChannel {
    case .general: return "Supervisor"
    case .needsYou: return "Needs You"
    case .tasks: return "Tasks"
    case .sessions: return "Sessions"
    case .activity: return "Activity"
    case let .project(name): return "#\(name)"
    case let .subchannel(project, sub):
      let leaf = sub.split(separator: "/").dropFirst().joined(separator: "/")
      return "#\(project)/\(leaf.isEmpty ? sub : leaf)"
    }
  }

  private var navigationSubtitleText: String {
    switch activeChannel {
    case .general:
      return "Synced across Mac, Paseo, iPhone, and Even G2 · \(runningCount) running · \(waitingTotal) waiting"
    case .needsYou:
      return waitingTotal == 0 ? "Queue clear" : "\(waitingTotal) awaiting decision or approval"
    case .tasks:
      return "\(supervisor.tasks.count) open task\(supervisor.tasks.count == 1 ? "" : "s") · \(supervisor.allTasks.count) total"
    case .sessions:
      let checkSuffix = SupervisorQuietCheckFormatter.badge(nextCheckISO: fleet.nextTickAt).map { " · \($0)" } ?? ""
      return "\(runningCount) running · \(sessionBriefs.count) watched\(checkSuffix)"
    case .activity:
      return "\(fleet.activityEvents.count) recent event\(fleet.activityEvents.count == 1 ? "" : "s")"
    case let .project(name):
      let count = SupervisorChannelGrouping.filterSessions(sessionBriefs, project: name).count
      return "\(count) session\(count == 1 ? "" : "s") in #\(name)"
    case let .subchannel(project, sub):
      let count = SupervisorChannelGrouping.filterSessions(sessionBriefs, project: project, subchannel: sub).count
      return "\(count) session\(count == 1 ? "" : "s") in /\(sub.split(separator: "/").last ?? Substring(sub))"
    }
  }

  private var activeTargetLabel: String {
    if composerMode == .startTask {
      let target = activeProjectAndSubchannel.project.map { "#\($0)" } ?? "Agent Queue"
      return composerClaimInPaseo
        ? "Create Task & Claim in Paseo (\(target))"
        : "Create Synced Task (\(target))"
    }
    switch activeChannel {
    case .general, .needsYou, .tasks, .sessions, .activity:
      return "Synced Supervisor (Mac · Paseo · Phone · G2)"
    case let .project(name):
      return "Scoped to #\(name) · Synced Supervisor"
    case let .subchannel(project, sub):
      let leaf = sub.split(separator: "/").dropFirst().joined(separator: "/")
      return "Scoped to #\(project)/\(leaf.isEmpty ? sub : leaf) · Synced Supervisor"
    }
  }

  private var activeProjectAndSubchannel: (project: String?, subchannel: String?) {
    switch activeChannel {
    case let .project(name):
      return (name, nil)
    case let .subchannel(project, sub):
      return (project, sub)
    default:
      return (nil, nil)
    }
  }

  private var availableBoardLabels: [SupervisorBoardLabel] {
    var tags: [String] = []
    for q in fleet.questions { tags.append(contentsOf: q.labels) }
    for t in fleet.threads { tags.append(contentsOf: t.labels) }
    for tk in supervisor.allTasks { tags.append(contentsOf: tk.tags ?? []) }
    return Array(SupervisorBoardLabel.extract(from: tags).prefix(14))
  }

  private var orderedInspectorSelections: [WorkspaceInspectorSelection] {
    switch activeChannel {
    case .needsYou:
      let layout = needsYouLayout
      let updates = showNeedsYouUpdates ? layout.updates : []
      return (layout.groups.flatMap(\.questions) + updates).map { .question($0.id) }
    case .tasks:
      return filteredBoardTasks.map { .task($0.id) }
    case .sessions, .general:
      return sessionBriefs.map { .session($0.id) }
    case .activity:
      return filteredActivityEvents.map { .activity($0.id) }
    case let .project(name):
      return projectDecisionQuestions(name, subchannel: nil).map { .question($0.id) }
        + SupervisorChannelGrouping.filterSessions(sessionBriefs, project: name).map { .session($0.id) }
    case let .subchannel(project, sub):
      return projectDecisionQuestions(project, subchannel: sub).map { .question($0.id) }
        + SupervisorChannelGrouping.filterSessions(sessionBriefs, project: project, subchannel: sub).map { .session($0.id) }
    }
  }

  /// Needs You in display order: actionable questions grouped by project,
  /// FYIs and completions apart, and one why-line per row.
  private struct NeedsYouLayout {
    struct ProjectGroup: Identifiable {
      let project: String
      let questions: [FleetQuestion]
      var id: String { project.lowercased() }
    }
    var groups: [ProjectGroup] = []
    var updates: [FleetQuestion] = []
    var reasons: [String: String] = [:]
  }

  private var needsYouLayout: NeedsYouLayout {
    let byID = Dictionary(fleet.questions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let visible = decisionItems.filter { item in
      let q = byID[item.id]
      guard matchesQuery([item.project, item.headline, q?.body]) else { return false }
      return SupervisorBoardLabel.matches(tags: q?.labels ?? [], activeFilters: activeLabelFilters)
    }
    var layout = NeedsYouLayout()
    layout.groups = SupervisorChannelGrouping.groupByProject(visible).map { group in
      NeedsYouLayout.ProjectGroup(project: group.project, questions: group.items.compactMap { byID[$0.id] })
    }
    layout.updates = fleet.questions.filter { q in
      !SupervisorAttentionCounting.isActionable(needsYou: q.needsYou)
        && matchesQuery([q.title, q.decisionHeadline, q.body, q.project])
        && SupervisorBoardLabel.matches(tags: q.labels, activeFilters: activeLabelFilters)
    }
    let rows = layout.groups.flatMap(\.questions)
    let reasons = SupervisorNeedsYouDigest.rowReasons(for: rows.map { $0.needsYouDigest(card: fleet.cardBriefs[$0.id]) })
    for (q, reason) in zip(rows, reasons) {
      if let reason { layout.reasons[q.id] = reason }
    }
    return layout
  }

  /// Actionable questions in one project (and theme), as the project
  /// channel lists them.
  private func projectDecisionQuestions(_ projName: String, subchannel: String?) -> [FleetQuestion] {
    let byID = Dictionary(fleet.questions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return decisionItems.compactMap { item -> FleetQuestion? in
      guard item.project.caseInsensitiveCompare(projName) == .orderedSame else { return nil }
      if let subchannel, !subchannel.isEmpty {
        let iSub = (item.subchannel ?? "").lowercased()
        if iSub != subchannel.lowercased() && !iSub.hasSuffix("/\(subchannel.lowercased())") { return nil }
      }
      guard let q = byID[item.id] else { return nil }
      guard matchesQuery([item.headline, item.project, q.body]) else { return nil }
      return SupervisorBoardLabel.matches(tags: q.labels, activeFilters: activeLabelFilters) ? q : nil
    }
  }

  private func isSelectedQuestion(_ id: String) -> Bool {
    inspectorSelection == .question(id)
  }

  /// Arrow keys move the selection through the list; the inspector, when
  /// open, follows it.
  private func moveSelection(_ delta: Int) {
    let list = orderedInspectorSelections
    guard !list.isEmpty else { return }
    guard let current = inspectorSelection, let idx = list.firstIndex(of: current) else {
      inspectorSelection = delta < 0 ? list.last : list.first
      return
    }
    let next = min(max(0, idx + delta), list.count - 1)
    inspectorSelection = list[next]
  }

  private func openInspector(_ selection: WorkspaceInspectorSelection) {
    inspectorSelection = selection
    isInspectorOpen = true
  }

  private func stepInspector(_ delta: Int) {
    let list = orderedInspectorSelections
    guard !list.isEmpty else { return }
    guard let current = inspectorSelection, let idx = list.firstIndex(of: current) else {
      inspectorSelection = list.first
      return
    }
    let nextIdx = idx + delta
    guard list.indices.contains(nextIdx) else { return }
    inspectorSelection = list[nextIdx]
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
      await fleet.loadHierarchy()
      await approvals.refresh()
      AppDelegate.updateDockBadge(count: waitingTotal)
    }
    .onChange(of: waitingTotal) { _, count in
      AppDelegate.updateDockBadge(count: count)
    }
    .onChange(of: nav.requestedQuestionID, initial: true) { _, id in
      guard let id else { return }
      openInspector(.question(id))
      nav.requestedQuestionID = nil
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

        sidebarBadgeRow(title: "Activity", systemImage: "bolt.horizontal.circle", count: fleet.activityEvents.count, highlight: false)
          .tag(WorkspaceChannel.activity)
      }

      Section {
        let primaryProjects = Array(projectChannels.prefix(8))
        let overflowProjects = Array(projectChannels.dropFirst(8))
        ForEach(primaryProjects) { summary in
          projectSidebarRows(summary)
        }
        if !overflowProjects.isEmpty {
          DisclosureGroup(isExpanded: $showMoreProjects) {
            ForEach(overflowProjects) { summary in
              projectSidebarRows(summary)
            }
          } label: {
            Label("More projects (\(overflowProjects.count))", systemImage: "ellipsis.circle")
              .font(.caption.weight(.medium))
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
        if projectChannels.isEmpty {
          Text("No projects yet — click + to organize.")
            .font(.caption)
            .foregroundStyle(WorkspaceTheme.muted)
        }
      } header: {
        HStack {
          Text("Projects")
          Spacer()
          Button {
            showNewProjectPopover.toggle()
          } label: {
            Image(systemName: "plus")
              .font(.caption.weight(.semibold))
          }
          .buttonStyle(.plain)
          .help("Create OpenAGI Project & Theme")
          .popover(isPresented: $showNewProjectPopover) {
            VStack(alignment: .leading, spacing: 10) {
              Text("New Project / Theme")
                .font(.headline)
              TextField("Project name (e.g. Marketing, openAGI)", text: $newProjectName)
                .textFieldStyle(.roundedBorder)
              TextField("Optional theme (e.g. SEO, Mobile)", text: $newProjectTheme)
                .textFieldStyle(.roundedBorder)
              TextField("Merge folder alias (optional, e.g. web-client)", text: $newProjectAlias)
                .textFieldStyle(.roundedBorder)
              HStack {
                Spacer()
                Button("Cancel") { showNewProjectPopover = false }
                Button("Save") {
                  let name = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
                  let theme = newProjectTheme.trimmingCharacters(in: .whitespacesAndNewlines)
                  let alias = newProjectAlias.trimmingCharacters(in: .whitespacesAndNewlines)
                  guard !name.isEmpty else { return }
                  Task {
                    let ok = await fleet.upsertProject(
                      name: name,
                      theme: theme.isEmpty ? nil : theme,
                      alias: alias.isEmpty ? nil : alias
                    )
                    if ok {
                      newProjectName = ""
                      newProjectTheme = ""
                      newProjectAlias = ""
                      showNewProjectPopover = false
                      nav.selectedChannel = .project(name)
                    }
                  }
                }
                .buttonStyle(.borderedProminent)
                .disabled(newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
              }
            }
            .padding(14)
            .frame(width: 280)
          }
        }
      }
    }
    .listStyle(.sidebar)
    .navigationSplitViewColumnWidth(min: 205, ideal: 232, max: 275)
    .sheet(isPresented: Binding(
      get: { organizingSessionKey != nil },
      set: { if !$0 { organizingSessionKey = nil } }
    )) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Organize Session in OpenAGI")
          .font(.headline)
        Text("Assign this coding session to an OpenAGI project & theme (works across Paseo, Codex, Claude Code, Conductor, and Antigravity).")
          .font(.caption)
          .foregroundStyle(.secondary)
        TextField("Project (e.g. openAGI, Marketing)", text: $organizeProjectDraft)
          .textFieldStyle(.roundedBorder)
        TextField("Theme / Subchannel (e.g. Mobile, SEO)", text: $organizeThemeDraft)
          .textFieldStyle(.roundedBorder)
        HStack {
          Button("Reset to Auto") {
            guard let key = organizingSessionKey else { return }
            Task {
              _ = await fleet.organizeThread(key: key, project: nil, theme: nil)
              organizingSessionKey = nil
            }
          }
          Spacer()
          Button("Cancel") { organizingSessionKey = nil }
          Button("Move") {
            guard let key = organizingSessionKey else { return }
            let proj = organizeProjectDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            let theme = organizeThemeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            Task {
              _ = await fleet.organizeThread(key: key, project: proj.isEmpty ? nil : proj, theme: theme.isEmpty ? nil : theme)
              organizingSessionKey = nil
            }
          }
          .buttonStyle(.borderedProminent)
        }
      }
      .padding(18)
      .frame(width: 340)
    }
  }

  @ViewBuilder
  private func projectSidebarRows(_ summary: SupervisorChannelSummary) -> some View {
    let projName = projectName(for: summary)
    let subs = mergedSubchannels(forProject: projName)
    if subs.isEmpty {
      sidebarChannelRow(title: projName, systemImage: "number", waiting: summary.waitingCount)
        .tag(WorkspaceChannel.project(projName))
    } else {
      DisclosureGroup(isExpanded: projectExpansion(projName, waiting: summary.waitingCount)) {
        ForEach(subs) { sub in
          sidebarChannelRow(
            title: sub.displayName.hasPrefix("/") ? String(sub.displayName.dropFirst()) : sub.displayName,
            systemImage: nil,
            waiting: sub.waitingCount
          )
          .tag(WorkspaceChannel.subchannel(project: projName, subchannel: sub.subchannel))
        }
      } label: {
        sidebarChannelRow(title: projName, systemImage: "number", waiting: summary.waitingCount)
          .tag(WorkspaceChannel.project(projName))
      }
    }
  }

  /// Open when the owner opened it, else when something in it waits on
  /// them or it (or one of its themes) is selected.
  private func projectExpansion(_ projName: String, waiting: Int) -> Binding<Bool> {
    let key = projName.lowercased()
    return Binding(
      get: {
        if collapsedProjects.contains(key) { return false }
        if expandedProjects.contains(key) { return true }
        switch activeChannel {
        case let .project(name), let .subchannel(name, _):
          if name.lowercased() == key { return true }
        default:
          break
        }
        return waiting > 0
      },
      set: { open in
        if open {
          expandedProjects.insert(key)
          collapsedProjects.remove(key)
        } else {
          collapsedProjects.insert(key)
          expandedProjects.remove(key)
        }
      }
    )
  }

  /// A project or theme in the sidebar: its name, and a count only when
  /// decisions there wait on the owner.
  private func sidebarChannelRow(title: String, systemImage: String?, waiting: Int) -> some View {
    HStack(spacing: 6) {
      if let systemImage {
        Label(title, systemImage: systemImage)
          .lineLimit(1)
      } else {
        Text(title)
          .lineLimit(1)
      }
      Spacer(minLength: 4)
      if waiting > 0 {
        Text("\(waiting)")
          .font(.caption2.weight(.semibold).monospacedDigit())
          .padding(.horizontal, 6)
          .padding(.vertical, 1)
          .background(WorkspaceTheme.caution.opacity(0.16), in: Capsule())
          .foregroundStyle(WorkspaceTheme.caution)
          .accessibilityLabel("\(waiting) waiting on you")
      }
    }
    .help(title)
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
          case .activity:
            activityStage
          case let .project(projName):
            projectStage(projName)
          case let .subchannel(projName, subName):
            projectStage(projName, subchannel: subName)
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
      // Keyboard selection keeps the selected row in view.
      .onChange(of: inspectorSelection) { _, selection in
        if case let .question(id)? = selection {
          withAnimation(.easeOut(duration: 0.15)) {
            proxy.scrollTo("needs-you-\(id)")
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
    .inspector(isPresented: $isInspectorOpen) {
      Group {
        if let selection = inspectorSelection {
          let list = orderedInspectorSelections
          let idx = list.firstIndex(of: selection)
          SupervisorThreadInspectorView(
            selection: selection,
            fleet: fleet,
            supervisor: supervisor,
            activeLabelFilters: $activeLabelFilters,
            canStepBackward: (idx ?? 0) > 0,
            canStepForward: idx.map { $0 + 1 < list.count } ?? (!list.isEmpty),
            onStep: { delta in stepInspector(delta) },
            onClose: { isInspectorOpen = false },
            onOpenQuestionInChat: { q in
              composerMode = .chat
              composerText = "About \"\(q.title)\": "
              inlineChatOpen = true
              composerFocused = true
            },
            onClaimTask: { task in
              Task {
                claimingTaskIDs.insert(task.id)
                defer { claimingTaskIDs.remove(task.id) }
                if let tk = await supervisor.claimTaskInPaseo(task) {
                  openInspector(.session(tk))
                }
              }
            },
            onPromoteSessionToTask: { thread in
              let proj = SupervisorChannelGrouping.normalizeProject(repo: thread.repo, workspace: thread.workspace, cwd: thread.cwd)
              Task {
                await supervisor.createBoardTask(
                  title: "Follow up: \(thread.name)",
                  description: thread.lastAgentText ?? "",
                  project: proj,
                  subchannel: thread.subchannel,
                  labels: thread.labels,
                  startSession: false
                )
              }
            }
          )
        } else {
          VStack(spacing: 8) {
            Image(systemName: "sidebar.trailing")
              .font(.title2)
              .foregroundStyle(WorkspaceTheme.muted)
            Text("Thread Inspector")
              .font(WorkspaceTheme.Typography.headline)
            Text("Select any decision, session, task, or activity event to inspect its live transcript, milestones, and reply directly.")
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
              .multilineTextAlignment(.center)
              .padding(.horizontal, 24)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(WorkspaceTheme.canvas)
        }
      }
      .inspectorColumnWidth(min: 310, ideal: 365, max: 460)
    }
  }

  @ToolbarContentBuilder
  private var toolbarItems: some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      Button {
        if inspectorSelection == nil, let first = orderedInspectorSelections.first {
          inspectorSelection = first
        }
        isInspectorOpen.toggle()
      } label: {
        Label("Inspector", systemImage: "sidebar.trailing")
      }
      .help("Toggle Thread Inspector")
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
                    modelId: "gpt-6.2-sol"
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
        Menu {
          if let b = supervisor.budgetStatus {
            Text(String(format: "Today: $%.2f / $%.2f", b.spentUsd, b.effectiveLimit))
            Divider()
          }
          Button("Add $10 for Today") {
            Task { _ = await supervisor.updateBudget(addUsdToday: 10) }
          }
          Button("Add $25 for Today") {
            Task { _ = await supervisor.updateBudget(addUsdToday: 25) }
          }
          if let bonus = supervisor.budgetStatus?.bonusUsdToday, bonus > 0 {
            Button("Reset Today's Extra") {
              Task { _ = await supervisor.updateBudget(resetTodayBonus: true) }
            }
          }
          Divider()
          ForEach([10.0, 25.0, 50.0, 100.0], id: \.self) { limit in
            Button {
              Task { _ = await supervisor.updateBudget(dailyUsdLimit: limit) }
            } label: {
              if let b = supervisor.budgetStatus, abs(b.dailyUsdLimit - limit) < 0.01 {
                Label(String(format: "Daily Limit: $%.0f/day", limit), systemImage: "checkmark")
              } else {
                Text(String(format: "Daily Limit: $%.0f/day", limit))
              }
            }
          }
        } label: {
          Label("Daily Budget", systemImage: "dollarsign.circle")
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
    let latestHitBudget = (supervisor.messages.last?.role == "assistant"
      && ((supervisor.messages.last?.text.localizedCaseInsensitiveContains("daily budget exceeded") ?? false)
          || (supervisor.messages.last?.text.localizedCaseInsensitiveContains("daily budget reached") ?? false)))
      || (supervisor.lastError?.localizedCaseInsensitiveContains("daily budget") ?? false)
    if supervisor.budgetStatus?.isExceeded == true || latestHitBudget {
      HStack(spacing: WorkspaceTheme.Spacing.x3) {
        Image(systemName: "dollarsign.circle.fill")
          .foregroundStyle(WorkspaceTheme.alert)
        VStack(alignment: .leading, spacing: 2) {
          Text("Daily budget limit reached")
            .font(WorkspaceTheme.Typography.secondary.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.ink)
          if let b = supervisor.budgetStatus {
            Text(String(format: "Spent $%.2f of $%.2f today. Add room for today or raise your daily limit.", b.spentUsd, b.effectiveLimit))
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          } else {
            Text("Add budget for today or raise your daily limit to continue.")
              .font(WorkspaceTheme.Typography.caption)
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
        Spacer()
        WorkspaceActionButton(prominent: true, small: true) {
          Task { _ = await supervisor.updateBudget(addUsdToday: 10) }
        } label: {
          Text("+$10 Today")
        }
        .disabled(supervisor.isUpdatingBudget)
        WorkspaceActionButton(prominent: false, small: true) {
          Task { _ = await supervisor.updateBudget(addUsdToday: 25) }
        } label: {
          Text("+$25 Today")
        }
        .disabled(supervisor.isUpdatingBudget)
        WorkspaceActionButton(prominent: false, small: true) {
          Task { _ = await supervisor.updateBudget(dailyUsdLimit: 50) }
        } label: {
          Text("Set $50/day")
        }
        .disabled(supervisor.isUpdatingBudget)
      }
      .padding(WorkspaceTheme.Spacing.x3)
      .workspaceCardSurface(cornerRadius: WorkspaceTheme.cardRadius)
    }

    if waitingTotal > 0 {
      HStack(spacing: WorkspaceTheme.Spacing.x3) {
        Image(systemName: "bell.badge.fill")
          .foregroundStyle(WorkspaceTheme.caution)
        VStack(alignment: .leading, spacing: 2) {
          Text("\(waitingTotal) item\(waitingTotal == 1 ? "" : "s") need your input")
            .font(WorkspaceTheme.Typography.secondary.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.ink)
          Text("\(decisionItems.count) decisions · \(approvals.items.count) tool approvals · \(supervisor.tasks.count) tasks")
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

    let layout = needsYouLayout

    if !availableBoardLabels.isEmpty {
      WorkspaceLabelChipsRow(labels: availableBoardLabels, activeFilters: $activeLabelFilters)
    }

    if layout.groups.isEmpty && filteredApprovals.isEmpty {
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
    }

    if !layout.groups.isEmpty || !layout.updates.isEmpty {
      VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x3) {
        ForEach(layout.groups) { group in
          VStack(alignment: .leading, spacing: 2) {
            NeedsYouGroupHeader(
              title: group.project.lowercased() == "general" ? "#general" : "#\(group.project)",
              count: group.questions.count,
              onOpen: group.project.lowercased() == "general" ? nil : { nav.selectedChannel = .project(group.project) }
            )
            ForEach(group.questions) { q in
              needsYouRow(q, reason: layout.reasons[q.id])
            }
          }
        }

        if !layout.updates.isEmpty {
          DisclosureGroup(isExpanded: $showNeedsYouUpdates) {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(layout.updates) { q in
                needsYouRow(q, reason: nil, isUpdate: true)
              }
            }
            .padding(.top, 2)
          } label: {
            HStack(spacing: 6) {
              Text("Updates · no decision needed")
                .font(.caption.weight(.semibold))
                .foregroundStyle(WorkspaceTheme.muted)
              Text("\(layout.updates.count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(WorkspaceTheme.muted.opacity(0.8))
            }
          }
          .padding(.horizontal, WorkspaceTheme.Spacing.x3)
          .padding(.top, WorkspaceTheme.Spacing.x2)
        }
      }
      .focusable()
      .focused($needsYouListFocused)
      .focusEffectDisabled()
      .onMoveCommand { direction in
        switch direction {
        case .up: moveSelection(-1)
        case .down: moveSelection(1)
        default: break
        }
      }
      .onKeyPress(.return) {
        if inspectorSelection == nil { moveSelection(1) }
        guard inspectorSelection != nil else { return .ignored }
        isInspectorOpen = true
        return .handled
      }
      .onExitCommand {
        isInspectorOpen = false
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Needs You")
    }
  }

  /// One compact Needs You row; clicking selects it and opens the inspector.
  private func needsYouRow(_ q: FleetQuestion, reason: String?, isUpdate: Bool = false) -> some View {
    let card = fleet.cardBriefs[q.id]
    return NeedsYouRow(
      title: (q.decisionHeadline ?? q.title).trimmingCharacters(in: .whitespacesAndNewlines),
      reason: reason,
      badge: isUpdate ? nil : q.needsYouBadge(card: card),
      meta: q.needsYouMeta(),
      isSelected: isSelectedQuestion(q.id),
      isUpdate: isUpdate
    ) {
      needsYouListFocused = true
      openInspector(.question(q.id))
    }
    .id("needs-you-\(q.id)")
  }

  private var taskOpenQuestionKeys: Set<String> {
    Set(fleet.questions.compactMap(\.threadKey))
  }

  private func boardState(for task: MacTaskItem) -> SupervisorBoardTaskState {
    let linkedKey = task.sourceMeta?.threadKey
    let hasOpenQ = linkedKey.map { taskOpenQuestionKeys.contains($0) } ?? false
    return SupervisorBoardTaskClassifier.classify(
      status: task.status,
      queue: task.queue,
      hasUnmetDeps: !(task.dependsOn ?? []).isEmpty && task.status.lowercased() == "blocked",
      hasOpenQuestion: hasOpenQ,
      leaseExpiresAtISO: task.sourceMeta?.agentLease?.expiresAt
    )
  }

  private var filteredBoardTasks: [MacTaskItem] {
    supervisor.allTasks.filter { task in
      guard matchesQuery([task.title, task.notes, task.description, task.sourceMeta?.project, task.sourceMeta?.actor]) else {
        return false
      }
      if selectedTaskStateFilter != .all && boardState(for: task) != selectedTaskStateFilter {
        return false
      }
      return SupervisorBoardLabel.matches(tags: task.tags ?? [], activeFilters: activeLabelFilters)
    }
  }

  private var filteredActivityEvents: [FleetActivityEvent] {
    fleet.activityEvents.filter { ev in
      guard matchesQuery([ev.title, ev.detail, ev.actor, ev.project, ev.subchannel, ev.prRef]) else { return false }
      return SupervisorBoardLabel.matches(tags: ev.labels, activeFilters: activeLabelFilters)
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
          Task { await supervisor.createBoardTask(title: t, startSession: false) }
        }
      WorkspaceActionButton(small: true) {
        let t = newTaskTitle
        newTaskTitle = ""
        Task { await supervisor.createBoardTask(title: t, startSession: true) }
      } label: {
        Label("Claim in Paseo", systemImage: "bolt.fill")
      }
      .disabled(newTaskTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .help("Create this task and start a Paseo coding session immediately")

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

    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(SupervisorBoardTaskState.allCases) { state in
          let count = state == .all
            ? supervisor.allTasks.count
            : supervisor.allTasks.filter { boardState(for: $0) == state }.count
          let active = selectedTaskStateFilter == state
          Button {
            selectedTaskStateFilter = state
          } label: {
            HStack(spacing: 5) {
              Image(systemName: state.systemImage)
                .font(.caption2.weight(.semibold))
              Text(state.label)
                .font(.caption.weight(.semibold))
              Text("\(count)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(active ? .white.opacity(0.85) : WorkspaceTheme.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(active ? WorkspaceTheme.live : WorkspaceTheme.surface, in: Capsule())
            .foregroundStyle(active ? Color.white : WorkspaceTheme.ink)
            .overlay(Capsule().strokeBorder(WorkspaceTheme.edge, lineWidth: active ? 0 : 0.5))
          }
          .buttonStyle(.plain)
        }
      }
    }

    let taskLabels = SupervisorBoardLabel.extract(from: supervisor.allTasks.flatMap { $0.tags ?? [] })
    WorkspaceLabelChipsRow(labels: taskLabels, activeFilters: $activeLabelFilters)

    let visibleTasks = filteredBoardTasks
    if visibleTasks.isEmpty {
      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        Text(trimmedQuery.isEmpty ? "No tasks in \(selectedTaskStateFilter.label)." : "No tasks matching \"\(trimmedQuery)\".")
          .font(WorkspaceTheme.Typography.body.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
        Text("New tasks added here or from your phone sync automatically across queues and Paseo sessions.")
          .font(WorkspaceTheme.Typography.secondary)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, WorkspaceTheme.Spacing.x8)
    } else {
      WorkspaceRowGroup {
        ForEach(Array(visibleTasks.enumerated()), id: \.element.id) { idx, task in
          if idx > 0 { WorkspaceHairline() }
          let st = boardState(for: task)
          let leaseText = SupervisorBoardTaskClassifier.leaseBadgeText(expiresAtISO: task.sourceMeta?.agentLease?.expiresAt)
          let isDone = st == .done
          let isSelected = inspectorSelection == .task(task.id) || (task.sourceMeta?.threadKey != nil && inspectorSelection == .session(task.sourceMeta!.threadKey!))
          HStack(alignment: .top, spacing: WorkspaceTheme.Spacing.x3) {
            Button {
              if !isDone {
                Task { await supervisor.completeTask(task.id) }
              }
            } label: {
              Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(isDone ? WorkspaceTheme.muted : WorkspaceTheme.live)
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .disabled(isDone)
            .help(isDone ? "Completed" : "Complete task")

            Button {
              openInspector(.task(task.id))
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                  Text(task.title)
                    .font(WorkspaceTheme.Typography.body.weight(isDone ? .regular : .medium))
                    .strikethrough(isDone)
                    .foregroundStyle(isDone ? WorkspaceTheme.muted : WorkspaceTheme.ink)
                  Spacer(minLength: 4)
                  Text(leaseText ?? st.label)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(boardStateColor(st).opacity(0.14), in: Capsule())
                    .foregroundStyle(boardStateColor(st))
                }

                HStack(spacing: 6) {
                  if let proj = task.sourceMeta?.project, !proj.isEmpty {
                    Text("#\(proj)")
                      .font(.caption2.weight(.semibold))
                      .foregroundStyle(WorkspaceTheme.muted)
                  }
                  if let sub = task.sourceMeta?.subchannel, !sub.isEmpty {
                    Text("/\(sub.split(separator: "/").last ?? Substring(sub))")
                      .font(.caption2)
                      .foregroundStyle(WorkspaceTheme.muted)
                  }
                  if let actor = task.sourceMeta?.actor, !actor.isEmpty {
                    WorkspaceActorPill(actor: actor)
                  }
                }

                if let desc = task.description ?? task.notes, !desc.isEmpty {
                  Text(desc)
                    .font(WorkspaceTheme.Typography.caption)
                    .foregroundStyle(WorkspaceTheme.muted)
                    .lineLimit(2)
                }

                let tLabels = SupervisorBoardLabel.extract(from: task.tags ?? [])
                WorkspaceLabelChipsRow(labels: tLabels, activeFilters: $activeLabelFilters)
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if task.sourceMeta?.threadKey == nil && !isDone {
              WorkspaceActionButton(small: true) {
                claimingTaskIDs.insert(task.id)
                Task {
                  defer { claimingTaskIDs.remove(task.id) }
                  if let tk = await supervisor.claimTaskInPaseo(task) {
                    openInspector(.session(tk))
                  }
                }
              } label: {
                if claimingTaskIDs.contains(task.id) {
                  ProgressView().controlSize(.mini)
                } else {
                  Label("Claim in Paseo", systemImage: "bolt.fill")
                }
              }
              .disabled(claimingTaskIDs.contains(task.id))
            } else if let tk = task.sourceMeta?.threadKey {
              WorkspaceActionButton(small: true) {
                openInspector(.session(tk))
              } label: {
                Label("Thread", systemImage: "sidebar.trailing")
              }
            }
          }
          .padding(.horizontal, WorkspaceTheme.Spacing.x4)
          .padding(.vertical, WorkspaceTheme.Spacing.x3)
          .background(isSelected ? WorkspaceTheme.live.opacity(0.07) : Color.clear)
        }
      }
    }
  }

  private func boardStateColor(_ st: SupervisorBoardTaskState) -> Color {
    switch st {
    case .blocked: return WorkspaceTheme.alert
    case .claimed: return WorkspaceTheme.live
    case .waiting: return WorkspaceTheme.caution
    case .ready: return .blue
    case .done, .all: return WorkspaceTheme.muted
    }
  }

  @ViewBuilder
  private var sessionsStage: some View {
    newSessionBar(defaultWorkspace: nil)
    if let nextLabel = SupervisorQuietCheckFormatter.badge(nextCheckISO: fleet.nextTickAt) {
      HStack(spacing: 8) {
        WorkspaceQuietCheckPill(label: nextLabel)
        Spacer()
      }
    }
    WorkspaceLabelChipsRow(labels: availableBoardLabels, activeFilters: $activeLabelFilters)

    let threadByKey = Dictionary(fleet.threads.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    let filtered = sessionBriefs.filter { s in
      guard matchesQuery([s.title, s.project, s.host, s.cwd]) else { return false }
      return SupervisorBoardLabel.matches(tags: threadByKey[s.id]?.labels ?? [], activeFilters: activeLabelFilters)
    }
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
  private var activityStage: some View {
    WorkspaceLabelChipsRow(labels: availableBoardLabels, activeFilters: $activeLabelFilters)
    let events = filteredActivityEvents
    if events.isEmpty {
      VStack(spacing: WorkspaceTheme.Spacing.x2) {
        Text(trimmedQuery.isEmpty ? "No recent activity yet." : "No activity matching \"\(trimmedQuery)\".")
          .font(WorkspaceTheme.Typography.body.weight(.medium))
          .foregroundStyle(WorkspaceTheme.ink)
        Text("Quiet self-checks, task claims, unblocks, and owner replies stream here.")
          .font(WorkspaceTheme.Typography.secondary)
          .foregroundStyle(WorkspaceTheme.muted)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, WorkspaceTheme.Spacing.x8)
    } else {
      WorkspaceRowGroup {
        ForEach(Array(events.enumerated()), id: \.element.id) { idx, ev in
          if idx > 0 { WorkspaceHairline() }
          Button {
            if let tk = ev.threadKey, !tk.isEmpty {
              openInspector(.session(tk))
            } else {
              openInspector(.activity(ev.id))
            }
          } label: {
            HStack(alignment: .top, spacing: WorkspaceTheme.Spacing.x3) {
              Image(systemName: activityIcon(for: ev.kind))
                .foregroundStyle(activityTint(for: ev.kind))
                .frame(width: 24, height: 24)
              VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                  Text(ev.title)
                    .font(WorkspaceTheme.Typography.body.weight(.medium))
                    .foregroundStyle(WorkspaceTheme.ink)
                  Spacer(minLength: 4)
                  if let at = ev.at.flatMap(FleetWatching.parseDate) {
                    Text(FleetThreadSummary.ago(at, now: Date()))
                      .font(.caption2)
                      .foregroundStyle(WorkspaceTheme.muted)
                  }
                }
                HStack(spacing: 6) {
                  if let actor = ev.actor, !actor.isEmpty {
                    WorkspaceActorPill(actor: actor)
                  }
                  if let proj = ev.project, !proj.isEmpty {
                    Text("#\(proj)")
                      .font(.caption2.weight(.semibold))
                      .foregroundStyle(WorkspaceTheme.muted)
                  }
                  if let sub = ev.subchannel, !sub.isEmpty {
                    Text("/\(sub.split(separator: "/").last ?? Substring(sub))")
                      .font(.caption2)
                      .foregroundStyle(WorkspaceTheme.muted)
                  }
                  if let pr = ev.prRef, !pr.isEmpty {
                    Text(pr)
                      .font(.caption2.monospaced())
                      .foregroundStyle(.blue)
                  }
                }
                if let detail = ev.detail, !detail.isEmpty {
                  Text(detail)
                    .font(WorkspaceTheme.Typography.caption)
                    .foregroundStyle(WorkspaceTheme.muted)
                    .lineLimit(2)
                }
              }
            }
            .padding(WorkspaceTheme.Spacing.x3)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  private func activityIcon(for kind: String) -> String {
    switch kind {
    case "held_question": return "questionmark.circle.fill"
    case "task_unblocked": return "lock.open.fill"
    case "task_claimed", "task-claim": return "bolt.fill"
    case "task_completed": return "checkmark.seal.fill"
    case "session-start": return "play.circle.fill"
    default: return "clock.arrow.circlepath"
    }
  }

  private func activityTint(for kind: String) -> Color {
    switch kind {
    case "held_question": return WorkspaceTheme.caution
    case "task_unblocked", "task_claimed", "task-claim", "task_completed": return WorkspaceTheme.live
    default: return WorkspaceTheme.muted
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
              Text("GPT-6.2 Sol").tag("gpt-6.2-sol")
              Text("GPT-5.4").tag("gpt-5.4")
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
  private func projectStage(_ projName: String, subchannel: String? = nil) -> some View {
    let projectSessionsAll = SupervisorChannelGrouping.filterSessions(sessionBriefs, project: projName, subchannel: subchannel)
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

    WorkspaceLabelChipsRow(labels: availableBoardLabels, activeFilters: $activeLabelFilters)

    let waiting = projectDecisionQuestions(projName, subchannel: subchannel)
    if !waiting.isEmpty {
      let reasons = SupervisorNeedsYouDigest.rowReasons(for: waiting.map { $0.needsYouDigest(card: fleet.cardBriefs[$0.id]) })
      let reasonByID = Dictionary(zip(waiting.map(\.id), reasons), uniquingKeysWith: { first, _ in first })
      VStack(alignment: .leading, spacing: 2) {
        NeedsYouGroupHeader(title: "Waiting on you", count: waiting.count)
        ForEach(waiting) { q in
          needsYouRow(q, reason: reasonByID[q.id] ?? nil)
        }
      }
    }

    newSessionBar(defaultWorkspace: projName)

    let threadByKey = Dictionary(fleet.threads.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    let projSessions = projectSessionsAll.filter { s in
      guard matchesQuery([s.title, s.host, s.cwd]) else { return false }
      return SupervisorBoardLabel.matches(tags: threadByKey[s.id]?.labels ?? [], activeFilters: activeLabelFilters)
    }
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

  private func toggleThreadExpand(_ key: String) {
    if expandedThreadKeys.contains(key) {
      expandedThreadKeys.remove(key)
    } else {
      expandedThreadKeys.insert(key)
      Task { await fleet.loadDetail(key) }
    }
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
          openInspector(.session(session.id))
        } label: {
          HStack(spacing: WorkspaceTheme.Spacing.x3) {
            Circle()
              .fill(isRunning ? WorkspaceTheme.live : WorkspaceTheme.muted.opacity(0.4))
              .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(session.title)
                  .font(WorkspaceTheme.Typography.body.weight(.semibold))
                  .foregroundStyle(WorkspaceTheme.ink)
                if showProjectTag {
                  Text("#\(session.project)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(WorkspaceTheme.muted)
                }
                if let sub = thread?.subchannel ?? session.subchannel, !sub.isEmpty {
                  Text("/\(sub.split(separator: "/").last ?? Substring(sub))")
                    .font(.caption2.monospaced())
                    .foregroundStyle(WorkspaceTheme.muted)
                }
              }
              HStack(spacing: 6) {
                if let actor = thread?.actorLabel, !actor.isEmpty {
                  WorkspaceActorPill(actor: actor)
                }
                if let nextLabel = SupervisorQuietCheckFormatter.badge(nextCheckISO: thread?.nextCheckAt ?? fleet.nextTickAt) {
                  WorkspaceQuietCheckPill(label: nextLabel)
                }
                if let linkedTask = supervisor.tasks.first(where: { $0.sourceMeta?.threadKey == session.id }) {
                  Text("Task · \(linkedTask.title)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(WorkspaceTheme.live)
                    .lineLimit(1)
                }
              }
              Text([session.state, session.host, session.cwd, thread?.prShortRef].compactMap { $0 }.joined(separator: " · "))
                .font(WorkspaceTheme.Typography.dataMono)
                .foregroundStyle(WorkspaceTheme.muted)
                .lineLimit(1)
              if let tLabels = thread?.labels, !tLabels.isEmpty {
                WorkspaceLabelChipsRow(labels: SupervisorBoardLabel.extract(from: tLabels), activeFilters: $activeLabelFilters)
              }
            }
            Spacer()
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        WorkspaceActionButton(small: true) {
          openInspector(.session(session.id))
        } label: {
          Label("Inspect", systemImage: "sidebar.trailing")
        }
        .help("Open in Thread Inspector")

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
    .contextMenu {
      Button("Move to Project / Theme…", systemImage: "folder.badge.gearshape") {
        organizeProjectDraft = session.project == "general" ? "" : session.project
        organizeThemeDraft = session.theme == "General" ? "" : session.theme
        organizingSessionKey = session.id
      }
      if !projectChannels.isEmpty {
        Menu("Quick Move to Project") {
          ForEach(projectChannels.prefix(12)) { ch in
            let targetProj = projectName(for: ch)
            Button("# \(targetProj)") {
              Task { _ = await fleet.organizeThread(key: session.id, project: targetProj, theme: nil) }
            }
          }
        }
      }
    }
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
        // The transcript may already hold this reply (a sync mid-stream):
        // then only the progress line shows, never a second copy.
        VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
          if let liveText = supervisor.liveReplyText {
            WorkspaceMarkdownContent(blocks: WorkspaceMarkdownParser.parse(liveText))
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

  private static func extractApprovalCode(from text: String) -> String? {
    let pattern = #"(?i)\bsay\s+['"\u2018\u2019\u201C\u201D`]*yes\s+(\d{2,3})['"\u2018\u2019\u201C\u201D`]*"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = regex.firstMatch(in: text, range: range),
          match.numberOfRanges > 1,
          let codeRange = Range(match.range(at: 1), in: text) else { return nil }
    return String(text[codeRange])
  }

  private func assistantDocumentRow(_ msg: SyncedSupervisorMessage, showsActions: Bool) -> some View {
    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
      WorkspaceMarkdownContent(blocks: WorkspaceMarkdownParser.parse(msg.text))
      if showsActions {
        if let code = Self.extractApprovalCode(from: msg.text) {
          HStack(spacing: 8) {
            WorkspaceActionButton(prominent: true, small: true) {
              Task { _ = await supervisor.sendMessage("yes \(code)") }
            } label: {
              Label("Approve", systemImage: "checkmark.circle.fill")
            }
            WorkspaceActionButton(small: true) {
              Task { _ = await supervisor.sendMessage("no \(code)") }
            } label: {
              Text("Cancel")
            }
          }
          .padding(.top, 2)
        }
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

  /// While a reply runs: what Send will do (the tray menu preference) and
  /// the other choice for this one message.
  private var busySendChoice: some View {
    let preference = BusySendBehavior(rawValue: busySendPreference) ?? .default
    return HStack(spacing: 8) {
      Text(preference == .queue ? "A reply is running. Send queues this." : "A reply is running. Send stops it and sends this next.")
        .font(.caption)
        .foregroundStyle(WorkspaceTheme.muted)
      Spacer()
      Button(preference.other == .sendNow ? "Send anyway" : "Queue instead") {
        sendFromWorkspace(override: preference.other)
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .help(preference.other == .sendNow
        ? "Stop the current reply and send this next (⌥↩). An action already running finishes; nothing is undone."
        : "Wait until the current reply and earlier queued messages finish (⌥↩).")
    }
    .padding(.horizontal, 10)
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
        SupervisorQueueTray(supervisor: supervisor)
      }

      if supervisor.isBusy && composerMode != .startTask
          && (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !composerImages.isEmpty) {
        busySendChoice
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
        // ⌥↩ while a reply runs: the other choice for this one message.
        .onKeyPress(.return, phases: .down) { press in
          guard press.modifiers.contains(.option), supervisor.isBusy, composerMode != .startTask else { return .ignored }
          sendFromWorkspace(override: supervisor.busySendBehavior.other)
          return .handled
        }

      HStack(spacing: 2) {
        ForEach(WorkspaceComposerMode.allCases) { mode in
          let active = composerMode == mode
          Button {
            composerMode = mode
          } label: {
            Text(mode.label)
              .font(.caption2.weight(.semibold))
              .padding(.horizontal, 8)
              .padding(.vertical, 4)
              .background(active ? WorkspaceTheme.live : Color.clear, in: Capsule())
              .foregroundStyle(active ? Color.white : WorkspaceTheme.muted)
          }
          .buttonStyle(.plain)
        }
      }
      .padding(2)
      .background(WorkspaceTheme.muted.opacity(0.12), in: Capsule())

      if composerMode == .startTask {
        Button {
          composerClaimInPaseo.toggle()
        } label: {
          Label("Paseo", systemImage: composerClaimInPaseo ? "bolt.fill" : "bolt")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
              (composerClaimInPaseo ? WorkspaceTheme.live : WorkspaceTheme.muted).opacity(0.16),
              in: Capsule()
            )
            .foregroundStyle(composerClaimInPaseo ? WorkspaceTheme.live : WorkspaceTheme.muted)
        }
        .buttonStyle(.plain)
        .help(composerClaimInPaseo ? "Claim & launch Paseo coding session on submit" : "Queue task without starting Paseo")
      }

      if activeChannel != .general && composerMode == .chat {
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
      .help(supervisor.isBusy
        ? "\(supervisor.busySendBehavior.busyLabel) (⌥↩: \(supervisor.busySendBehavior.other == .sendNow ? "Send anyway" : "Queue instead"))"
        : "Send to Supervisor")
      .accessibilityLabel(supervisor.isBusy ? supervisor.busySendBehavior.busyLabel : "Send to Supervisor")
      .contextMenu {
        if supervisor.isBusy && canSend && composerMode != .startTask {
          Button("Queue message") { sendFromWorkspace(override: .queue) }
          Button("Send anyway") { sendFromWorkspace(override: .sendNow) }
        }
      }
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
    if composerMode == .startTask {
      if let proj = activeProjectAndSubchannel.project {
        return composerClaimInPaseo
          ? "Start a tracked Paseo task in #\(proj)…"
          : "Add a tracked task to #\(proj)…"
      }
      return composerClaimInPaseo
        ? "Describe a Board task to claim & run in Paseo…"
        : "Describe a new Board task…"
    }
    switch activeChannel {
    case .general:
      return "Message Supervisor (drop or attach screenshots)…"
    case let .project(name):
      return "Ask Supervisor about #\(name)…"
    case let .subchannel(project, sub):
      let leaf = sub.split(separator: "/").dropFirst().joined(separator: "/")
      return "Ask Supervisor about #\(project)/\(leaf.isEmpty ? sub : leaf)…"
    case .needsYou, .tasks, .sessions, .activity:
      return "Ask Supervisor…"
    }
  }

  /// `override`: the one-message choice against the "while a reply is
  /// running" preference ("Send anyway" / "Queue instead"; also ⌥↩).
  private func sendFromWorkspace(override: BusySendBehavior? = nil) {
    var rawDraft = composerText
    var imgs = composerImages
    let extracted = WorkspaceImageAttachment.extractInlineLocalImages(from: rawDraft, limit: max(0, 4 - imgs.count))
    if !extracted.attachments.isEmpty {
      rawDraft = extracted.cleanedText
      appendAttachments(extracted.attachments, to: &imgs)
    }
    let raw = rawDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty || !imgs.isEmpty else { return }

    if composerMode == .startTask {
      let scope = activeProjectAndSubchannel
      let cleanTitle = raw.isEmpty ? "Screenshot task" : String(raw.prefix(120))
      composerText = ""
      composerImages = []
      composerStatusNote = composerClaimInPaseo ? "Creating task and claiming in Paseo…" : "Creating Board task…"
      Task {
        let ok = await supervisor.createBoardTask(
          title: cleanTitle,
          description: raw,
          project: scope.project,
          subchannel: scope.subchannel,
          startSession: composerClaimInPaseo,
          workspace: scope.project
        )
        composerStatusNote = ok ? (composerClaimInPaseo ? "Task claimed in Paseo." : "Board task added.") : nil
        if ok {
          nav.selectedChannel = .tasks
        } else if composerText.isEmpty {
          composerText = rawDraft
        }
      }
      return
    }

    let textToSend: String
    if case let .project(projName) = activeChannel {
      textToSend = raw.isEmpty ? "[\(projName)] Please inspect the attached screenshot(s)." : "[\(projName)] \(raw)"
      inlineChatOpen = true
    } else if case let .subchannel(projName, subName) = activeChannel {
      let leaf = subName.split(separator: "/").dropFirst().joined(separator: "/")
      let tag = leaf.isEmpty ? projName : "\(projName)/\(leaf)"
      textToSend = raw.isEmpty ? "[\(tag)] Please inspect the attached screenshot(s)." : "[\(tag)] \(raw)"
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
      let ok = await supervisor.sendMessage(textToSend, attachments: imgs, override: override)
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
