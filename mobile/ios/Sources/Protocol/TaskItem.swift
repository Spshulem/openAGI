import Foundation

public struct TaskItem: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let bucket: String
    public let status: String
    public let priority: Int
    public let dueDate: Date?
    public let overdue: Bool
}
