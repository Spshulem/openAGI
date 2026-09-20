import Foundation
import WidgetKit

public enum RefreshOutcome: Sendable, Equatable {
    case updated(Snapshot)
    case unchanged
    case unauthorized
    case offline
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
        do {
            switch try await client.summary(ifNoneMatch: store.load()?.etag) {
            case .unchanged:
                if var snapshot = store.load() {
                    snapshot.fetchedAt = Date()
                    try? store.save(snapshot)
                }
                reloadWidgets()
                return .unchanged
            case let .fresh(summary, etag):
                let snapshot = try store.storeFresh(summary: summary, etag: etag)
                reloadWidgets()
                return .updated(snapshot)
            }
        } catch DaemonError.unauthorized {
            return .unauthorized
        } catch {
            return .offline
        }
    }

    public func drainQueue() async {
        for op in queue.all() {
            switch op.kind {
            case let .completeTask(taskID):
                do {
                    try await client.complete(taskID: taskID)
                    try? queue.remove(id: op.id)
                } catch DaemonError.notFound, DaemonError.conflict {
                    // The server has already moved on. Replaying cannot help.
                    try? queue.remove(id: op.id)
                } catch {
                    try? queue.recordAttempt(id: op.id)
                }
            }
        }
    }

    private func reloadWidgets() {
        WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetKind.value)
    }
}
