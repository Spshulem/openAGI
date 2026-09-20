import Foundation
import Observation
import WidgetKit

// RootTabView's five destinations. A plain enum (not the `Tab` views
// themselves) so any screen behind the tab bar can request a switch --
// e.g. Today's "N waiting on you" row jumping to Inbox, per DESIGN.md's
// "Screens must not be mostly empty" section -- without needing a callback
// threaded down through every intermediate view.
enum AppTab: Hashable {
    case today, tasks, inbox, chat, settings
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

    private(set) var snapshot: Snapshot?
    private(set) var lastOutcome: RefreshOutcome?
    private(set) var isRefreshingToday = false

    // Plain UI state, not persisted -- which tab RootTabView's `TabView` is
    // showing. Any view behind the tab bar can set this directly.
    var selectedTab: AppTab = .today

    private(set) var pendingActionsCount = 0
    private(set) var clarificationsCount = 0

    // Bumped whenever a live event or a manual action means Tasks/Inbox
    // should refetch; views observe this rather than polling on a timer.
    private(set) var tasksGeneration = 0
    private(set) var inboxGeneration = 0

    private var eventStream: EventStreamController?

    var inboxBadgeCount: Int { pendingActionsCount + clarificationsCount }

    init(credentials: Credentials) {
        self.credentials = credentials
        self.client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        self.store = SnapshotStore()
        self.queue = OutboundQueue()
        self.snapshot = store.load()
    }

    private var coordinator: RefreshCoordinator {
        RefreshCoordinator(client: client, store: store, queue: queue)
    }

    var statusLine: String {
        if case .unauthorized = lastOutcome { return "Needs re-pairing" }
        return credentials.server.host ?? credentials.server.absoluteString
    }

    var ageMinutes: Int { snapshot?.ageInMinutes() ?? 0 }
    var refreshFailed: Bool {
        if case .offline = lastOutcome { return true }
        return snapshot?.lastRefreshFailedAt != nil
    }

    // MARK: - Today

    func refreshToday() async {
        isRefreshingToday = true
        defer { isRefreshingToday = false }
        lastOutcome = await coordinator.refresh()
        snapshot = store.load()
    }

    // Optimistic: hide the row immediately, queue the completion, then try
    // to send it right away. Repaints the widget itself -- whole-branch
    // review finding: this used to only happen from RefreshCoordinator's own
    // `refresh()`, so ticking a task off from inside the app left the home
    // screen widget showing it as still open.
    func completeToday(taskID: String) async {
        snapshot = try? store.applyOptimisticCompletion(taskID: taskID)
        try? queue.enqueue(PendingOp(kind: .completeTask(taskID)))
        await coordinator.drainQueue()
        snapshot = store.load()
        WidgetReload.reloadToday()
    }

    // MARK: - Inbox badge

    func refreshInboxCounts() async {
        async let actions = try? client.pendingActions(status: "pending")
        async let clarifications = try? client.clarifications(status: "pending")
        let (a, c) = await (actions, clarifications)
        if let a { pendingActionsCount = a.count }
        if let c { clarificationsCount = c.count }
    }

    func bumpTasksGeneration() { tasksGeneration += 1 }
    func bumpInboxGeneration() { inboxGeneration += 1; Task { await refreshInboxCounts() } }

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
        case .hello, .unknown:
            break
        }
    }

    // MARK: - Revoke

    func revoke() async {
        try? await client.revoke()
        stopEventStream()
        Credentials.clear()
        try? SnapshotStore().delete()
        try? OutboundQueue().clear()
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
