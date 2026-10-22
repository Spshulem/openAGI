import Foundation
import WidgetKit

public enum RefreshOutcome: Sendable, Equatable {
    case updated(Snapshot)
    case unchanged
    case unauthorized
    case offline
    case mainUnavailable(MainConnectionIssue)
}

public actor RefreshCoordinator {
    private let client: DaemonClient
    private let store: SnapshotStore
    private let queue: OutboundQueue

    public init(client: DaemonClient, store: SnapshotStore = SnapshotStore(), queue: OutboundQueue = OutboundQueue()) {
        self.client = client
        self.store = store
        self.queue = queue
    }

    // Order matters: send what the user already did before asking what is true,
    // or a refresh will hand back the state their tap was meant to change.
    public func refresh() async -> RefreshOutcome {
        await drainQueue()
        guard !Task.isCancelled else { return .offline }
        // Whole-branch review finding: `heartbeat()` existed, was tested, and
        // was never called by anything, so a paired phone's `lastSeen` never
        // advanced past enrollment. This is the one place that covers
        // foreground refresh, pull-to-refresh, and background refresh with a
        // single call. Best-effort: the daemon's node roster is a
        // convenience, never something a refresh should fail over.
        _ = try? await client.heartbeat()
        do {
            let response = try await client.summary(ifNoneMatch: store.load()?.etag)
            // Pairing transitions run on MainActor. Keep the cancellation
            // check and disk write together there so detach cannot delete
            // the snapshot between the check and an old response's write.
            return try await MainActor.run {
                try Task.checkCancellation()
                switch response {
                case .unchanged:
                    try? store.touchFetchedAt()
                    reloadWidgets()
                    return .unchanged
                case let .fresh(summary, etag):
                    let snapshot = try store.storeFresh(summary: summary, etag: etag)
                    reloadWidgets()
                    return .updated(snapshot)
                }
            }
        } catch DaemonError.unauthorized {
            return .unauthorized
        } catch DaemonError.mainConnection(let issue) {
            await recordFailureUnlessCancelled()
            return .mainUnavailable(issue)
        } catch {
            // Whole-branch review finding: this outcome never reached the
            // snapshot, so the widget (which only reads what's on disk) had
            // no way to tell "daemon has been down for hours" from "healthy,
            // just polled recently" until the unrelated 60-minute staleness
            // threshold happened to also trip.
            await recordFailureUnlessCancelled()
            return .offline
        }
    }

    // The daemon marks a node offline 90s after its last heartbeat
    // (src/node-registry.js's ONLINE_WINDOW_MS, 3x a 30s send interval), and
    // it never counts an attached `GET /events` stream as liveness. `refresh()`
    // alone left an open-but-idle phone showing offline after 90s, since the
    // next refresh could be a 15-minute background wake away. RootTabView runs
    // this for as long as the paired UI is up; cancelling the task ends it.
    public static let heartbeatInterval: Duration = .seconds(30)

    public static func sendHeartbeats(client: DaemonClient, every interval: Duration = heartbeatInterval) async {
        while !Task.isCancelled {
            _ = try? await client.heartbeat()
            try? await Task.sleep(for: interval)
        }
    }

    public func drainQueue() async {
        for op in queue.all() {
            guard !Task.isCancelled else { return }
            switch op.kind {
            case let .completeTask(taskID):
                do {
                    try await client.complete(taskID: taskID)
                    try Task.checkCancellation()
                    try? queue.remove(id: op.id)
                } catch DaemonError.notFound, DaemonError.conflict {
                    guard !Task.isCancelled else { return }
                    // The server has already moved on. Replaying cannot help.
                    try? queue.remove(id: op.id)
                } catch {
                    guard !Task.isCancelled else { return }
                    try? queue.recordAttempt(id: op.id)
                }
            }
        }
    }

    private func recordFailureUnlessCancelled() async {
        await MainActor.run {
            guard !Task.isCancelled else { return }
            try? store.recordRefreshFailure()
            reloadWidgets()
        }
    }

    nonisolated private func reloadWidgets() {
        WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetKind.value)
    }
}
