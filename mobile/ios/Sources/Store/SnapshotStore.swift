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
        CoordinatedFile.read(file) { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? ProtocolDecoder.json.decode(Snapshot.self, from: data)
        }
    }

    public func save(_ snapshot: Snapshot) throws {
        let data = try ProtocolDecoder.jsonEncoder.encode(snapshot)
        try CoordinatedFile.write(file) { url in
            // Atomic: a widget reading mid-write must never see half a file.
            try data.write(to: url, options: .atomic)
        }
    }

    // Read-modify-write, coordinated: the widget's AppIntent and the app's
    // refresh coordinator can both call this from different processes, so the
    // read of the current snapshot and the write of the mutated one must be
    // one uninterruptible unit or a concurrent write from the other side can
    // be lost.
    @discardableResult
    public func applyOptimisticCompletion(taskID: String) throws -> Snapshot? {
        try CoordinatedFile.write(file) { url -> Snapshot? in
            guard let data = try? Data(contentsOf: url),
                  var snapshot = try? ProtocolDecoder.json.decode(Snapshot.self, from: data) else {
                return nil
            }
            snapshot.locallyCompleted.insert(taskID)
            try ProtocolDecoder.jsonEncoder.encode(snapshot).write(to: url, options: .atomic)
            return snapshot
        }
    }

    // Called after a successful fetch: keep only the optimistic ids the server
    // still lists as open, so the set cannot grow forever. Also a
    // read-modify-write, coordinated for the same reason as above.
    public func storeFresh(summary: MobileSummary, etag: String?, now: Date = Date()) throws -> Snapshot {
        try CoordinatedFile.write(file) { url -> Snapshot in
            let previous: Set<String>
            if let data = try? Data(contentsOf: url),
               let existing = try? ProtocolDecoder.json.decode(Snapshot.self, from: data) {
                previous = existing.locallyCompleted
            } else {
                previous = []
            }
            let stillOpen = Set(summary.today.map(\.id))
            let snapshot = Snapshot(summary: summary, fetchedAt: now, etag: etag,
                                    locallyCompleted: previous.intersection(stillOpen))
            try ProtocolDecoder.jsonEncoder.encode(snapshot).write(to: url, options: .atomic)
            return snapshot
        }
    }
}
