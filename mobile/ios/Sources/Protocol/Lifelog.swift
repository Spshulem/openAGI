import Foundation

// `GET /lifelog/moments?date=YYYY-MM-DD&query=` -- what the owner's G2
// glasses heard, as moments (a title, a short summary and the transcript),
// newest first, across every enrolled G2. Every field but `id` is optional:
// a moment still being reviewed may have no title or summary yet, and that
// must show as an emptier row, never as a failed screen.
public struct LifelogMoment: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let nodeId: String?
    public let deviceName: String?
    public let at: Date?
    public let endAt: Date?
    public let title: String?
    public let summary: String?
    public let transcript: String?

    public init(id: String, nodeId: String? = nil, deviceName: String? = nil, at: Date? = nil, endAt: Date? = nil,
                title: String? = nil, summary: String? = nil, transcript: String? = nil) {
        self.id = id
        self.nodeId = nodeId
        self.deviceName = deviceName
        self.at = at
        self.endAt = endAt
        self.title = title
        self.summary = summary
        self.transcript = transcript
    }

    private enum CodingKeys: String, CodingKey {
        case id, nodeId, deviceName, at, endAt, title, summary, transcript
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        nodeId = try? c.decodeIfPresent(String.self, forKey: .nodeId)
        deviceName = try? c.decodeIfPresent(String.self, forKey: .deviceName)
        at = try c.decodeIfPresent(Date.self, forKey: .at)
        endAt = try c.decodeIfPresent(Date.self, forKey: .endAt)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        transcript = try? c.decodeIfPresent(String.self, forKey: .transcript)
    }
}

public struct LifelogMomentsResponse: Decodable, Sendable, Equatable {
    public let moments: [LifelogMoment]

    private enum CodingKeys: String, CodingKey { case moments }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        moments = ((try? c.decodeIfPresent([Lenient<LifelogMoment>].self, forKey: .moments)) ?? []).compactMap(\.value)
    }
}
