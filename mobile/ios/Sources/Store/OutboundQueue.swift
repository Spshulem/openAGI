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
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? ProtocolDecoder.json.decode([PendingOp].self, from: data)) ?? []
    }

    public func enqueue(_ op: PendingOp) throws {
        var ops = all()
        // Tapping the same row twice is one intent, not two.
        guard !ops.contains(where: { $0.kind == op.kind }) else { return }
        ops.append(op)
        try write(ops)
    }

    public func remove(id: UUID) throws {
        try write(all().filter { $0.id != id })
    }

    public func recordAttempt(id: UUID) throws {
        var ops = all()
        guard let index = ops.firstIndex(where: { $0.id == id }) else { return }
        ops[index].attempts += 1
        // An op that has failed this many times is not going to start working.
        // Dropping it is better than a queue that retries forever on every
        // background wake.
        if ops[index].attempts >= Self.maxAttempts { ops.remove(at: index) }
        try write(ops)
    }

    private func write(_ ops: [PendingOp]) throws {
        try ProtocolDecoder.jsonEncoder.encode(ops).write(to: file, options: .atomic)
    }
}
