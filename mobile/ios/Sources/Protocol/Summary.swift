import Foundation

public struct MobileSummary: Codable, Sendable, Equatable {
    public struct Counts: Codable, Sendable, Equatable {
        public let today: Int
        public let thisWeek: Int
        public let overdue: Int
        public let pendingActions: Int

        private enum CodingKeys: String, CodingKey {
            case today
            case thisWeek = "this_week"
            case overdue
            case pendingActions
        }
    }

    public struct PendingActionSummary: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let summary: String
        public let createdAt: Date?
    }

    public struct Brief: Codable, Sendable, Equatable {
        public let headline: String
    }

    public let generatedAt: Date
    public let today: [TaskItem]
    public let counts: Counts
    public let pendingActions: [PendingActionSummary]
    public let brief: Brief
}

public enum ProtocolDecoder {
    // The daemon speaks ISO-8601 with fractional seconds everywhere.
    public static let json: JSONDecoder = {
        let decoder = JSONDecoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = formatter.date(from: raw) ?? plain.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "unsupported date: \(raw)")
            )
        }
        return decoder
    }()

    public static let jsonEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
