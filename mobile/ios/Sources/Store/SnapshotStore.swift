import Foundation

public struct Snapshot: Codable, Sendable, Equatable {
    public var summary: MobileSummary
    public var fetchedAt: Date
    public var etag: String?
    public var locallyCompleted: Set<String>
    // Set when the most recent refresh attempt could not reach the daemon at
    // all (RefreshCoordinator's `.offline` outcome); cleared on the next
    // successful fetch (200 or 304). Whole-branch review finding: without
    // this, `RefreshOutcome.offline` never reached the snapshot, so a
    // widget reading only `fetchedAt`'s age rendered a daemon that had been
    // down for hours identically to a healthy one, right up until the
    // 60-minute staleness threshold. This is `Optional` (rather than a
    // non-optional `Bool`) so an on-disk snapshot written before this field
    // existed still decodes: a missing key becomes `nil`, not a decode
    // failure.
    public var lastRefreshFailedAt: Date?

    public init(summary: MobileSummary, fetchedAt: Date, etag: String?, locallyCompleted: Set<String>,
                lastRefreshFailedAt: Date? = nil) {
        self.summary = summary
        self.fetchedAt = fetchedAt
        self.etag = etag
        self.locallyCompleted = locallyCompleted
        self.lastRefreshFailedAt = lastRefreshFailedAt
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
            // A fetch that reached the daemon at all -- 200 or 304 -- proves
            // it is reachable right now, so any previously recorded failure
            // is cleared here.
            let snapshot = Snapshot(summary: summary, fetchedAt: now, etag: etag,
                                    locallyCompleted: previous.intersection(stillOpen),
                                    lastRefreshFailedAt: nil)
            try ProtocolDecoder.jsonEncoder.encode(snapshot).write(to: url, options: .atomic)
            return snapshot
        }
    }

    // Bumps `fetchedAt` only, for RefreshCoordinator's `.unchanged` (304)
    // path: the server said nothing changed, but the local "how stale is
    // this" clock should still reset. This has to be one read-modify-write,
    // coordinated like every other mutator here, not a `load()` then a
    // `save()`: those are two independently coordinated transactions, and a
    // concurrent `applyOptimisticCompletion` (a tap in TodayView, or the
    // widget's AppIntent, in a different process) landing between them would
    // be silently overwritten by the stale copy the first transaction
    // loaded. Returns nil (no-op) if there is no snapshot on disk yet, same
    // as the other read-modify-write mutators.
    @discardableResult
    public func touchFetchedAt(now: Date = Date()) throws -> Snapshot? {
        try CoordinatedFile.write(file) { url -> Snapshot? in
            guard let data = try? Data(contentsOf: url),
                  var snapshot = try? ProtocolDecoder.json.decode(Snapshot.self, from: data) else {
                return nil
            }
            snapshot.fetchedAt = now
            // A 304 also proves the daemon is reachable right now.
            snapshot.lastRefreshFailedAt = nil
            try ProtocolDecoder.jsonEncoder.encode(snapshot).write(to: url, options: .atomic)
            return snapshot
        }
    }

    // Records that the most recent refresh attempt could not reach the
    // daemon at all, so the widget (which never fetches itself and only
    // reads what this file already says) can render DESIGN.md's "Can't
    // reach OpenAGI" state instead of silently treating old data as current.
    // A read-modify-write, coordinated like every other mutator here.
    // No-ops (returns nil) if there is no snapshot on disk yet -- an
    // unpaired-or-never-synced phone has nothing for this flag to qualify.
    @discardableResult
    public func recordRefreshFailure(now: Date = Date()) throws -> Snapshot? {
        try CoordinatedFile.write(file) { url -> Snapshot? in
            guard let data = try? Data(contentsOf: url),
                  var snapshot = try? ProtocolDecoder.json.decode(Snapshot.self, from: data) else {
                return nil
            }
            snapshot.lastRefreshFailedAt = now
            try ProtocolDecoder.jsonEncoder.encode(snapshot).write(to: url, options: .atomic)
            return snapshot
        }
    }

    // Removes the snapshot file, coordinated like every other writer here.
    // Used on account revoke: a plain `FileManager.removeItem` bypasses this
    // file's whole coordination domain, so it is not mutually exclusive with
    // an overlapping `applyOptimisticCompletion`/`storeFresh`/`save` call —
    // it can land in the middle of one of those read-modify-write bodies and
    // be silently undone by that body's later atomic write. Routing the
    // removal through `CoordinatedFile.write` puts it in the same
    // NSFileCoordinator domain as every other accessor, so it can never be
    // interleaved mid-transaction with one of them.
    public func delete() throws {
        try CoordinatedFile.write(file) { url in
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
    }
}
