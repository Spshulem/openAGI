import Foundation
import Observation
import WidgetKit

// RootTabView's six destinations (mobile/FEATURES.md's Navigation). A plain enum (not the `Tab` views
// themselves) so any screen behind the tab bar can request a switch --
// e.g. Today's "N waiting on you" row jumping to Inbox, per DESIGN.md's
// "Screens must not be mostly empty" section -- without needing a callback
// threaded down through every intermediate view.
nonisolated enum AppTab: Hashable, Sendable {
    case today, tasks, inbox, chat, supervisor
}

// The one piece of shared state behind the tab bar: the paired credential,
// the daemon client built from it, the locally-cached snapshot, and the
// Inbox badge count. Every tab reads this rather than each building its own
// client and refresh logic, so a completion, an approval, or a live SSE
// event refreshes every surface that cares about it from one place.
@Observable
@MainActor
final class AppModel {
    let credentials: Credentials
    let client: DaemonClient
    let store: SnapshotStore
    let queue: OutboundQueue
    // The two shared device threads. Owned here, not by a view, so a reply
    // keeps streaming across tab switches and `/events` can refresh them.
    let agentChat: ChatConversation
    let supervisorChat: ChatConversation
    let conversations: ConversationLibrary

    private(set) var snapshot: Snapshot?
    private(set) var lastOutcome: RefreshOutcome?
    private(set) var isRefreshingToday = false
    private(set) var workspace: WorkspaceSnapshot
    private(set) var tasksErrors: [String: String] = [:]
    private(set) var loadingQueues: Set<String> = []
    private(set) var pendingActionsError: String?
    private(set) var clarificationsError: String?
    private(set) var isRefreshingInbox = false
    private let workspaceCache: WorkspaceCache
    @ObservationIgnored private var taskRefreshes: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var inboxRefresh: Task<Void, Never>?

    // Plain UI state, not persisted -- which tab RootTabView's `TabView` is
    // showing. Any view behind the tab bar can set this directly.
    var selectedTab: AppTab = .today

    private(set) var pendingActionsCount = 0
    private(set) var clarificationsCount = 0

    // Bumped whenever a live event or a manual action means Tasks/Inbox
    // should refetch; views observe this rather than polling on a timer.
    private(set) var tasksGeneration = 0
    private(set) var inboxGeneration = 0
    // Bumped on the daemon's `fleet` event; the Supervisor tab refetches.
    private(set) var fleetGeneration = 0

    private var eventStream: EventStreamController?
    @ObservationIgnored private var todayRefresh: Task<Void, Never>?
    private var isActive = true

    var inboxBadgeCount: Int { pendingActionsCount + clarificationsCount }

    init(credentials: Credentials, client: DaemonClient? = nil,
         store: SnapshotStore = SnapshotStore(), queue: OutboundQueue = OutboundQueue(),
         chatDirectory: URL = ChatHistoryStore.defaultDirectory) {
        let client = client ?? DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        self.credentials = credentials
        self.client = client
        self.store = store
        self.queue = queue
        self.snapshot = store.load()
        let workspaceCache = WorkspaceCache(credentials: credentials, directory: chatDirectory)
        self.workspaceCache = workspaceCache
        let cachedWorkspace = workspaceCache.load()
        self.workspace = cachedWorkspace
        self.pendingActionsCount = cachedWorkspace.pendingActions?.count ?? 0
        self.clarificationsCount = cachedWorkspace.clarifications?.count ?? 0
        self.agentChat = ChatConversation(thread: .agent, client: client,
                                          store: ChatHistoryStore(thread: ConversationThread.agent.rawValue, directory: chatDirectory),
                                          nodeID: credentials.nodeID)
        self.supervisorChat = ChatConversation(thread: .supervisor, client: client,
                                               store: ChatHistoryStore(thread: ConversationThread.supervisor.rawValue, directory: chatDirectory),
                                               nodeID: credentials.nodeID)
        self.conversations = ConversationLibrary(client: client, credentials: credentials, directory: chatDirectory,
                                                 agent: agentChat, supervisor: supervisorChat)
    }

    @ObservationIgnored private lazy var coordinator = RefreshCoordinator(client: client, store: store, queue: queue)

    var statusLine: String {
        if case .unauthorized = lastOutcome { return "Needs re-pairing" }
        return isOnPhone ? hostLabel : credentials.server.host ?? credentials.server.absoluteString
    }

    // Phone-only mode: the daemon is the one embedded in this app.
    var isOnPhone: Bool { credentials.isEmbedded }

    // The connection line names where the agent runs.
    var hostLabel: String { isOnPhone ? "This iPhone" : credentials.server.host ?? "" }

    // An attached fleet event stream does not establish that task data loaded.
    var dataStatus: String {
        switch lastOutcome {
        case .updated, .unchanged: "Synced"
        case .unauthorized: "Needs re-pairing"
        case .offline: snapshot == nil ? "Couldn't load data" : "Showing saved data"
        case .mainUnavailable: "Main connection needs attention"
        case nil: "Not synced yet"
        }
    }

    var ageMinutes: Int { snapshot?.ageInMinutes() ?? 0 }
    var mainConnectionIssue: MainConnectionIssue? {
        if case .mainUnavailable(let issue) = lastOutcome { return issue }
        return nil
    }
    var refreshFailed: Bool {
        if mainConnectionIssue != nil { return true }
        if case .offline = lastOutcome { return true }
        return snapshot?.lastRefreshFailedAt != nil
    }

    // MARK: - Today

    // Resume and reconnect can follow missed events or failed initial loads.
    // Refresh the observable model as well as disk, and invalidate both lists.
    func refreshData() async {
        guard isActive else { return }
        bumpTasksGeneration()
        workspace.inboxFetchedAt = nil
        inboxGeneration += 1
        async let inboxRefresh: Void = refreshInbox(force: true)
        async let tasksRefresh: Void = refreshTasks(queue: .user, force: true)
        async let agentTasksRefresh: Void = refreshTasks(queue: .agent, force: true)
        await refreshToday()
        _ = await (inboxRefresh, tasksRefresh, agentTasksRefresh)
    }

    func refreshToday() async {
        guard isActive else { return }
        if let todayRefresh {
            await todayRefresh.value
            return
        }
        // Resume, reconnect and the Today view can refresh together. Share
        // the whole operation so they cannot send the same queued completion.
        let refresh = Task {
            isRefreshingToday = true
            defer {
                isRefreshingToday = false
                todayRefresh = nil
            }
            let outcome = await coordinator.refresh()
            guard isActive, !Task.isCancelled else { return }
            lastOutcome = outcome
            snapshot = store.load()
        }
        todayRefresh = refresh
        await refresh.value
    }

    // Optimistic: hide the row immediately, queue the completion, then try
    // to send it right away. Repaints the widget itself -- whole-branch
    // review finding: this used to only happen from RefreshCoordinator's own
    // `refresh()`, so ticking a task off from inside the app left the home
    // screen widget showing it as still open.
    func completeToday(taskID: String) async {
        guard isActive else { return }
        snapshot = try? store.applyOptimisticCompletion(taskID: taskID)
        try? queue.enqueue(PendingOp(kind: .completeTask(taskID)))
        await coordinator.drainQueue()
        guard isActive, !Task.isCancelled else { return }
        snapshot = store.load()
        bumpTasksGeneration()
        WidgetReload.reloadToday()
    }

    // MARK: - Inbox badge

    func refreshInboxCounts() async { await refreshInbox() }

    // Views read disk-backed state synchronously; requests refresh it in the
    // background. Concurrent tab/foreground/SSE refreshes share one request.
    func refreshTasks(queue: TaskQueue, force: Bool = false) async {
        guard isActive else { return }
        let key = queue.rawValue
        if let running = taskRefreshes[key] { await running.value; return }
        if !force, let fetchedAt = workspace.tasksFetchedAt[key],
           Date().timeIntervalSince(fetchedAt) < 30 { return }
        let running = Task {
            loadingQueues.insert(key)
            defer { loadingQueues.remove(key); taskRefreshes[key] = nil }
            // If an event/mutation arrives during the request, fetch again
            // before declaring this queue fresh. Callers still coalesce.
            var generation: Int
            repeat {
                generation = tasksGeneration
                do {
                    let tasks = try await client.tasks(queue: key, limit: Int.max)
                    guard isActive, !Task.isCancelled else { return }
                    workspace.tasks[key] = tasks
                    workspace.tasksFetchedAt[key] = generation == tasksGeneration ? Date() : nil
                    tasksErrors[key] = nil
                    try? workspaceCache.save(workspace)
                } catch {
                    guard isActive, !Task.isCancelled else { return }
                    workspace.tasksFetchedAt[key] = nil
                    tasksErrors[key] = InboxLoader.message(for: error)
                }
            } while isActive && !Task.isCancelled && generation != tasksGeneration
        }
        taskRefreshes[key] = running
        await running.value
    }

    func refreshInbox(force: Bool = false) async {
        guard isActive else { return }
        if let running = inboxRefresh { await running.value; return }
        if !force, let fetchedAt = workspace.inboxFetchedAt,
           Date().timeIntervalSince(fetchedAt) < 30 { return }
        let running = Task {
            isRefreshingInbox = true
            defer { isRefreshingInbox = false; inboxRefresh = nil }
            var generation: Int
            repeat {
                generation = inboxGeneration
                // A slow or failing section cannot hide the other section.
                async let actions: Void = refreshPendingActions()
                async let questions: Void = refreshClarifications()
                _ = await (actions, questions)
                guard isActive, !Task.isCancelled else { return }
                workspace.inboxFetchedAt = pendingActionsError == nil && clarificationsError == nil
                    && generation == inboxGeneration ? Date() : nil
                try? workspaceCache.save(workspace)
            } while isActive && !Task.isCancelled && generation != inboxGeneration
        }
        inboxRefresh = running
        await running.value
    }

    private func refreshPendingActions() async {
        do {
            let actions = try await client.pendingActions(status: "pending")
            guard isActive, !Task.isCancelled else { return }
            workspace.pendingActions = actions
            pendingActionsCount = actions.count
            pendingActionsError = nil
        } catch {
            guard isActive, !Task.isCancelled else { return }
            pendingActionsError = InboxLoader.message(for: error)
        }
    }

    private func refreshClarifications() async {
        do {
            let questions = try await client.clarifications(status: "pending")
            guard isActive, !Task.isCancelled else { return }
            workspace.clarifications = questions
            clarificationsCount = questions.count
            clarificationsError = nil
        } catch {
            guard isActive, !Task.isCancelled else { return }
            clarificationsError = InboxLoader.message(for: error)
        }
    }

    func bumpTasksGeneration() {
        workspace.tasksFetchedAt = [:]
        tasksGeneration += 1
    }
    func bumpInboxGeneration() {
        workspace.inboxFetchedAt = nil
        inboxGeneration += 1
        Task { await refreshInbox(force: true) }
    }

    // MARK: - Live events

    func startEventStream() {
        guard eventStream == nil else { return }
        let controller = EventStreamController(client: client)
        eventStream = controller
        Task { [weak self] in
            guard let self else { return }
            for await event in controller.events() {
                self.handle(event)
            }
        }
    }

    func stopEventStream() {
        eventStream?.stop()
        eventStream = nil
    }

    var isStreamConnected: Bool { eventStream?.isConnected ?? false }

    private func handle(_ event: DaemonEvent) {
        switch event {
        case .taskUpdated, .taskAutoChanged:
            bumpTasksGeneration()
            Task { await refreshToday() }
        case .taskReminder:
            break
        case .pendingAction, .pendingActionResolved, .clarificationCreated:
            bumpInboxGeneration()
        case .conversationUpdated:
            // Another device (or this one) stored a turn in a shared thread.
            Task { await conversations.refreshOpenChats() }
        case .fleet:
            fleetGeneration += 1
        case .hello:
            // A (re)connected stream may have missed updates while it was down.
            Task { await refreshData() }
            Task { await conversations.refreshOpenChats() }
        case .unknown:
            break
        }
    }

    // MARK: - Revoke

    // Setup replay pauses the old model without deleting offline work. A
    // completed daemon switch still uses detach() to isolate its stores.
    func suspendForOnboarding() {
        invalidateRefresh()
        conversations.suspend()
    }

    func revoke() async {
        invalidateRefresh()
        // Local push state goes first; best-effort relay cleanup runs apart
        // from the credential revocation so a relay outage cannot delay it.
        await PushRegistrar.shared.forget(client: client)
        try? await client.revoke()
        stopEventStream()
        conversations.forget()
        Credentials.clear()
        workspaceCache.delete()
        try? store.delete()
        try? queue.clear()
    }

    // Leaves this daemon without revoking: switching between the agent on
    // this iPhone and a server keeps both credentials, but nothing cached
    // from one may show up as the other's.
    //
    // Leaving a Mac for the iPhone agent parks the Mac's queued work (task
    // completions made while it was unreachable) instead of dropping it;
    // switching back restores it.
    func detach(parkedQueue: OutboundQueue = .parkedForServer()) {
        invalidateRefresh()
        stopEventStream()
        conversations.forget()
        try? store.delete()
        if credentials.isEmbedded {
            try? queue.clear()
        } else {
            try? queue.move(to: parkedQueue)
        }
    }

    private func invalidateRefresh() {
        isActive = false
        todayRefresh?.cancel()
        taskRefreshes.values.forEach { $0.cancel() }
        inboxRefresh?.cancel()
        stopEventStream()
    }
}

// The widget lives in a separate process; both the app and the widget
// extension link WidgetKit, so this is a thin, testable-by-inspection
// wrapper rather than scattering `WidgetCenter.shared.reloadTimelines` calls
// at every call site that mutates the snapshot.
enum WidgetReload {
    static func reloadToday() {
        WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetKind.value)
    }
}
