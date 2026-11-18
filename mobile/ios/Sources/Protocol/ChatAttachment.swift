import Foundation

public struct ChatAttachment: Codable, Sendable, Equatable, Identifiable {
    public static let maximumCount = 4
    public let id: String
    public let name: String
    public let mimeType: String
    public let data: String?
    public let thumbnail: String?

    public init(id: String = UUID().uuidString, name: String, mimeType: String = "image/jpeg",
                data: String?, thumbnail: String? = nil) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.data = data
        self.thumbnail = thumbnail
    }

    public var previewOnly: ChatAttachment {
        ChatAttachment(id: id, name: name, data: nil, thumbnail: thumbnail)
    }
}
