import Foundation

public struct Snapshot: Codable, Sendable, Equatable {
    public var summary: MobileSummary
    public var fetchedAt: Date
    public var etag: String?
    public var locallyCompleted: Set<String>

    public init(summary: MobileSummary, fetchedAt: Date, etag: String?, locallyCompleted: Set<String>) {
        self.summary = summary
        self.fetchedAt = fetchedAt
        self.etag = etag
        self.locallyCompleted = locallyCompleted
    }

    // What the UI and widget actually draw: the server's list minus anything
    // completed here that the server has not caught up with yet.
    public var visibleToday: [TaskItem] {
        summary.today.filter { !locallyCompleted.contains($0.id) }
    }

    public var visibleCounts: MobileSummary.Counts {
        let hidden = summary.today.filter { locallyCompleted.contains($0.id) }
        return .init(
            today: max(0, summary.counts.today - hidden.count),
            thisWeek: summary.counts.thisWeek,
            overdue: max(0, summary.counts.overdue - hidden.filter(\.overdue).count),
            pendingActions: summary.counts.pendingActions
        )
    }

    public func ageInMinutes(now: Date = Date()) -> Int {
        max(0, Int(now.timeIntervalSince(fetchedAt) / 60))
    }
}

public struct SnapshotStore: Sendable {
    private let file: URL

    public init(directory: URL = SharedContainer.url) {
        self.file = directory.appending(path: "snapshot.json")
    }

    public func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? ProtocolDecoder.json.decode(Snapshot.self, from: data)
    }

    public func save(_ snapshot: Snapshot) throws {
        let data = try ProtocolDecoder.jsonEncoder.encode(snapshot)
        // Atomic: a widget reading mid-write must never see half a file.
        try data.write(to: file, options: .atomic)
    }

    @discardableResult
    public func applyOptimisticCompletion(taskID: String) throws -> Snapshot? {
        guard var snapshot = load() else { return nil }
        snapshot.locallyCompleted.insert(taskID)
        try save(snapshot)
        return snapshot
    }

    // Called after a successful fetch: keep only the optimistic ids the server
    // still lists as open, so the set cannot grow forever.
    public func storeFresh(summary: MobileSummary, etag: String?, now: Date = Date()) throws -> Snapshot {
        let previous = load()?.locallyCompleted ?? []
        let stillOpen = Set(summary.today.map(\.id))
        let snapshot = Snapshot(summary: summary, fetchedAt: now, etag: etag,
                                locallyCompleted: previous.intersection(stillOpen))
        try save(snapshot)
        return snapshot
    }
}
