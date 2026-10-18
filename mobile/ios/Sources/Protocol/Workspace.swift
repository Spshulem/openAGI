import Foundation

// The phone's workspace screens: GET/POST /settings/models and the
// /workspace/* routes (src/hosted-interface.js). Keys are write-only; the
// daemon only ever says whether one is set.

public struct ModelSettings: Decodable, Sendable, Equatable {
    public struct Active: Decodable, Sendable, Equatable {
        public let provider: String?
        public let model: String?
        public let offlineFallback: Bool?
    }
    public struct KeyProvider: Decodable, Sendable, Equatable {
        public let configured: Bool
        public let model: String?
    }
    public struct OnDevice: Decodable, Sendable, Equatable {
        public let available: Bool
        public let connected: Bool?
    }
    public struct ChatGPT: Decodable, Sendable, Equatable {
        public let signedIn: Bool
        public let email: String?
    }
    public struct Providers: Decodable, Sendable, Equatable {
        public let anthropic: KeyProvider
        public let openai: KeyProvider
        public let onDevice: OnDevice?
        public let chatgpt: ChatGPT?
    }
    public let preference: String
    public let active: Active
    public let providers: Providers

    // A stored key for a different provider does not make the selected model
    // usable. Phones without a local model need an active cloud provider.
    public var hasUsableCloudModel: Bool {
        switch active.provider {
        case "anthropic": providers.anthropic.configured
        case "openai": providers.openai.configured
        case "chatgpt": providers.chatgpt?.signedIn == true
        default: false
        }
    }
}

public struct ModelSettingsUpdate: Encodable, Sendable, Equatable {
    public var preference: String?
    public var anthropicKey: String?
    public var openaiKey: String?
    public var anthropicModel: String?
    public var openaiModel: String?
    public var clear: [String]?

    public init(preference: String? = nil, anthropicKey: String? = nil, openaiKey: String? = nil,
                anthropicModel: String? = nil, openaiModel: String? = nil, clear: [String]? = nil) {
        self.preference = preference
        self.anthropicKey = anthropicKey
        self.openaiKey = openaiKey
        self.anthropicModel = anthropicModel
        self.openaiModel = openaiModel
        self.clear = clear
    }
}

public struct ModelTestResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let model: String?
    public let text: String?
    public let message: String?
}

public struct PersonaDocument: Decodable, Sendable, Equatable {
    public let markdown: String
    public let name: String?
}

public struct SkillSummary: Decodable, Sendable, Equatable, Identifiable {
    public let name: String
    public let description: String
    public let editable: Bool
    public var id: String { name }
}

public struct SkillDetail: Decodable, Sendable, Equatable {
    public let name: String
    public let description: String
    public let instructions: String
    public let editable: Bool
}

public struct ScheduledJob: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let enabled: Bool
    public let dailyAt: String?
    public let intervalMs: Double?
    public let nextRunAt: String?
    public let lastRunAt: String?

    // "Daily at 08:00", "Every 15 min"
    public var scheduleLabel: String {
        if let dailyAt { return "Daily at \(dailyAt)" }
        guard let intervalMs, intervalMs > 0 else { return "On demand" }
        let minutes = Int(intervalMs / 60_000)
        if minutes < 60 { return "Every \(max(minutes, 1)) min" }
        let hours = minutes / 60
        return hours == 1 ? "Every hour" : "Every \(hours) hours"
    }
}

// A skill name the daemon accepts: lowercase letters, digits and dashes.
public enum SkillName {
    public static func slug(_ text: String) -> String {
        let lowered = text.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let collapsed = lowered.split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return String(collapsed.prefix(63))
    }
}
