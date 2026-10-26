import CryptoKit
import Foundation

// Read-through cache for one pairing. A new server, node or credential cannot
// read another workspace's lists. Today has its separate widget snapshot.
struct WorkspaceSnapshot: Codable, Sendable, Equatable {
    var tasks: [String: [TaskRecord]] = [:]
    var tasksFetchedAt: [String: Date] = [:]
    var pendingActions: [PendingAction]?
    var clarifications: [Clarification]?
    var inboxFetchedAt: Date?
}

struct WorkspaceCache: Sendable {
    private let file: URL

    init(credentials: Credentials, directory: URL) {
        let identity = "\(credentials.server.absoluteString)\n\(credentials.nodeID)\n\(credentials.token)"
        let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        file = directory.appending(path: "workspace-\(key).json")
    }

    func load() -> WorkspaceSnapshot {
        guard let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(WorkspaceSnapshot.self, from: data) else {
            return WorkspaceSnapshot()
        }
        return snapshot
    }

    func save(_ snapshot: WorkspaceSnapshot) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        // This is a private cache format, not the daemon's wire format.
        // Numeric dates preserve fractional seconds without expensive ISO
        // formatter creation for every cached task during app startup.
        try JSONEncoder().encode(snapshot).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func delete() {
        try? FileManager.default.removeItem(at: file)
    }
}
