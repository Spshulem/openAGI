import Foundation
import Observation

// The phone's copy of the Mac agent (spec: docs/superpowers/specs/
// 2026-10-16-openagi-phone-workspace-design.md, section 3).
//
// While paired to a Mac, the app keeps the daemon on this iPhone loaded with
// a snapshot of the Mac's chats, memory, instructions, skills and open
// tasks. If the Mac can't be reached, the person can continue on the phone
// agent with that context; when the Mac is back, what was added offline is
// sent to it (additions only) before switching back.
@MainActor
@Observable
final class OfflineCopy {
    static let shared = OfflineCopy()

    private(set) var lastSyncedAt: Date? = UserDefaults.standard.object(forKey: Keys.lastSynced) as? Date
    private(set) var isSyncing = false

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
            return true
        } catch {
            return false
        }
    }

    // Everything added on the phone since the last import, appended on the
    // Mac, then marked sent so a retry is empty. Returns how many items went.
    @discardableResult
    func sendOfflineWork(to client: DaemonClient) async throws -> Int {
        guard isAvailable, EmbeddedSecrets.load() != nil else { return 0 }
        let work = try await EmbeddedDaemon.shared.ownerRaw(path: "/mirror/offline", method: "GET")
        let count = Self.itemCount(work)
        guard count > 0 else { return 0 }
        try await client.sendOfflineWork(work)
        _ = try await EmbeddedDaemon.shared.ownerRaw(path: "/mirror/offline/sent", method: "POST", body: work)
        return count
    }

    static func itemCount(_ work: Data) -> Int {
        guard let object = try? JSONSerialization.jsonObject(with: work) as? [String: Any] else { return 0 }
        let messages = (object["messages"] as? [String: Any])?.values.reduce(0) { $0 + (($1 as? [Any])?.count ?? 0) } ?? 0
        let tasks = (object["tasks"] as? [Any])?.count ?? 0
        let memories = (object["memories"] as? [Any])?.count ?? 0
        return messages + tasks + memories
    }
}
