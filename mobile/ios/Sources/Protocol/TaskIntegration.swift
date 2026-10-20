import Foundation

public struct TaskIntegration: Decodable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let available: Bool
    public let configured: Bool
    public let apiKeySaved: Bool
    public let lastSyncedAt: Date?
}

public struct TaskIntegrationSync: Decodable, Sendable {
    public let ok: Bool
    public let created: Int?
    public let updated: Int?
    public let completed: Int?
    public let message: String?
}
