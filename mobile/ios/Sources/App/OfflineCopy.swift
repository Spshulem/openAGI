import Foundation
import Observation

// The phone's copy of the Mac agent (spec: docs/superpowers/specs/
// 2026-10-16-openagi-phone-workspace-design.md, section 3).
//
// While paired to a Mac, the app keeps the daemon on this iPhone loaded with
// a snapshot of the Mac's chats, memory, instructions, skills and open
// tasks. If the Mac can't be reached, the person can continue on the phone
// agent with that context; when the Mac is back, what was added offline is
// sent to it (additions only) in the background after reconnecting.
@MainActor
@Observable
final class OfflineCopy {
    static let shared = OfflineCopy()

    private(set) var lastSyncedAt: Date? = UserDefaults.standard.object(forKey: Keys.lastSynced) as? Date
    private(set) var isSyncing = false
    private(set) var syncIssue: String?

    private enum Keys {
        static let lastSynced = "sh.openagi.offlineCopy.lastSynced"
    }

    private static let minimumInterval: TimeInterval = 30 * 60

    var isAvailable: Bool { EmbeddedDaemon.isBundled }
    var hasCopy: Bool { lastSyncedAt != nil }

    // Pulls a fresh snapshot from the Mac into the phone's daemon. Throttled
    // unless forced; any unsent offline work goes to the Mac first so the
    // import never has to keep it aside.
    @discardableResult
    func sync(from client: DaemonClient, force: Bool = false) async -> Bool {
        guard isAvailable, !isSyncing else { return false }
        if !force, let lastSyncedAt, Date().timeIntervalSince(lastSyncedAt) < Self.minimumInterval { return false }
        isSyncing = true
        defer { isSyncing = false }
        do {
            try await sendOfflineWork(to: client)
            let snapshot = try await client.mirrorSnapshot()
            _ = try await EmbeddedDaemon.shared.ownerRaw(path: "/mirror/import", method: "POST", body: snapshot, timeout: 60)
            let now = Date()
            lastSyncedAt = now
            UserDefaults.standard.set(now, forKey: Keys.lastSynced)
            syncIssue = nil
            return true
        } catch {
            syncIssue = "Your phone-local changes are still saved on this iPhone. They haven't finished syncing with the server; reconnecting does not discard them."
            return false
        }
    }

    // Everything added on the phone since the last import, appended on the
    // Mac, then marked sent so a retry is empty. Returns how many items went.
    @discardableResult
    func sendOfflineWork(to client: DaemonClient) async throws -> Int {
        guard isAvailable, EmbeddedSecrets.load() != nil else { return 0 }
        return try await Self.sendPages(
            next: { try await EmbeddedDaemon.shared.ownerRaw(path: "/mirror/offline", method: "GET") },
            upload: { try await client.sendOfflineWork($0) },
            markSent: { _ = try await EmbeddedDaemon.shared.ownerRaw(path: "/mirror/offline/sent", method: "POST", body: $0) }
        )
    }

    // Acknowledging a page removes it from the next listing. Drain every
    // page before the caller reports success or switches to the server.
    static func sendPages(next: () async throws -> Data,
                          upload: (Data) async throws -> Void,
                          markSent: (Data) async throws -> Void) async throws -> Int {
        var total = 0
        while true {
            try Task.checkCancellation()
            let work = try await next()
            guard let object = try JSONSerialization.jsonObject(with: work) as? [String: Any] else {
                throw DaemonError.malformedResponse
            }
            let truncated = object["truncated"] as? Bool ?? false
            let count = itemCount(work)
            if count == 0 {
                guard !truncated else { throw DaemonError.malformedResponse }
                return total
            }
            try await upload(work)
            try await markSent(work)
            total += count
            if !truncated { return total }
        }
    }

    static func itemCount(_ work: Data) -> Int {
        guard let object = try? JSONSerialization.jsonObject(with: work) as? [String: Any] else { return 0 }
        let messages = (object["messages"] as? [String: Any])?.values.reduce(0) { $0 + (($1 as? [Any])?.count ?? 0) } ?? 0
        let tasks = (object["tasks"] as? [Any])?.count ?? 0
        let memories = (object["memories"] as? [Any])?.count ?? 0
        return messages + tasks + memories
    }
}
