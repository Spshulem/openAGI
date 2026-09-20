import Foundation

public struct PendingOp: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: Codable, Sendable, Equatable {
        case completeTask(String)
    }

    public let id: UUID
    public let kind: Kind
    public let createdAt: Date
    public var attempts: Int

    public init(id: UUID = UUID(), kind: Kind, createdAt: Date = Date(), attempts: Int = 0) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
        self.attempts = attempts
    }
}

public struct OutboundQueue: Sendable {
    public static let maxAttempts = 5
    private let file: URL

    public init(directory: URL = SharedContainer.url) {
        self.file = directory.appending(path: "outbox.json")
    }

    public func all() -> [PendingOp] {
        CoordinatedFile.read(file) { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? ProtocolDecoder.json.decode([PendingOp].self, from: data)
        } ?? []
    }

    // Every mutator here is a read-modify-write, coordinated: the widget's
    // AppIntent and the app's refresh coordinator both mutate this file from
    // different processes, so read-then-write must be one uninterruptible
    // unit or a concurrent enqueue/attempt from the other side can be lost.
    public func enqueue(_ op: PendingOp) throws {
        try CoordinatedFile.write(file) { url in
            var ops = Self.readOps(at: url)
            // Tapping the same row twice is one intent, not two.
            guard !ops.contains(where: { $0.kind == op.kind }) else { return }
            ops.append(op)
            try Self.writeOps(ops, to: url)
        }
    }

    public func remove(id: UUID) throws {
        try CoordinatedFile.write(file) { url in
            try Self.writeOps(Self.readOps(at: url).filter { $0.id != id }, to: url)
        }
    }

    public func recordAttempt(id: UUID) throws {
        try CoordinatedFile.write(file) { url in
            var ops = Self.readOps(at: url)
            guard let index = ops.firstIndex(where: { $0.id == id }) else { return }
            ops[index].attempts += 1
            // An op that has failed this many times is not going to start working.
            // Dropping it is better than a queue that retries forever on every
            // background wake.
            if ops[index].attempts >= Self.maxAttempts { ops.remove(at: index) }
            try Self.writeOps(ops, to: url)
        }
    }

    private static func readOps(at url: URL) -> [PendingOp] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? ProtocolDecoder.json.decode([PendingOp].self, from: data)) ?? []
    }

    private static func writeOps(_ ops: [PendingOp], to url: URL) throws {
        try ProtocolDecoder.jsonEncoder.encode(ops).write(to: url, options: .atomic)
    }
}
