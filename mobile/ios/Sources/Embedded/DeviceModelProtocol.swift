import Foundation

// The frames on WS /device/model, mirroring src/device-model-relay.js. The
// daemon runs the agent and its tool loop; this app only answers "given this
// conversation and these tools, what next: text, or one tool call?"

struct DeviceToolCall: Codable, Sendable, Equatable {
    let name: String
    let arguments: JSONValue
}

struct DeviceModelMessage: Codable, Sendable, Equatable {
    // "user", "assistant" (content, or a toolCall it made), or "tool" (a result).
    let role: String
    let content: String
    var toolCall: DeviceToolCall?
    var name: String?
}

struct DeviceModelTool: Codable, Sendable, Equatable {
    let name: String
    let description: String
    // A JSON Schema object, as the daemon's tool registry declares it.
    let parameters: JSONValue
}

struct DeviceGenerateRequest: Codable, Sendable, Equatable {
    let id: String
    let system: String
    let messages: [DeviceModelMessage]
    let tools: [DeviceModelTool]
    let maxOutputTokens: Int?
}

enum DeviceModelInbound: Sendable, Equatable {
    case generate(DeviceGenerateRequest)
    case cancel(id: String)
    case unknown

    static func decode(_ data: Data) -> DeviceModelInbound {
        struct Envelope: Decodable { let type: String; let id: String? }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return .unknown }
        switch envelope.type {
        case "generate":
            guard let request = try? JSONDecoder().decode(DeviceGenerateRequest.self, from: data) else { return .unknown }
            return .generate(request)
        case "cancel":
            return envelope.id.map { .cancel(id: $0) } ?? .unknown
        default:
            return .unknown
        }
    }
}

enum DeviceGenerateResult: Sendable, Equatable {
    case text(String)
    case toolCall(DeviceToolCall)
}

// A failure the daemon reports to the person as-is, so `message` is copy.
struct DeviceModelFailure: Error, Sendable, Equatable {
    let code: String
    let message: String

    static let unavailable = DeviceModelFailure(
        code: "device-model-unavailable",
        message: "This iPhone's on-device model isn't available right now."
    )
}

enum DeviceModelOutbound {
    static func hello(model: String, contextSize: Int) -> Data {
        encode(["type": .string("hello"), "model": .string(model), "contextSize": .number(Double(contextSize))])
    }

    static func delta(id: String, text: String) -> Data {
        encode(["type": .string("delta"), "id": .string(id), "text": .string(text)])
    }

    static func result(id: String, _ result: DeviceGenerateResult) -> Data {
        switch result {
        case .text(let text):
            return encode(["type": .string("result"), "id": .string(id), "text": .string(text)])
        case .toolCall(let call):
            return encode(["type": .string("result"), "id": .string(id),
                           "toolCall": .object(["name": .string(call.name), "arguments": call.arguments])])
        }
    }

    static func error(id: String, _ failure: DeviceModelFailure) -> Data {
        encode(["type": .string("error"), "id": .string(id), "code": .string(failure.code), "message": .string(failure.message)])
    }

    private static func encode(_ object: [String: JSONValue]) -> Data {
        (try? JSONEncoder().encode(JSONValue.object(object))) ?? Data("{}".utf8)
    }
}

// Small models do best with the conversation as one prompt: earlier turns as
// a transcript, then the request, then whatever tools ran this turn.
enum DeviceModelPrompt {
    static func render(_ messages: [DeviceModelMessage]) -> String {
        guard let latestUser = messages.lastIndex(where: { $0.role == "user" }) else {
            return messages.map(\.content).joined(separator: "\n")
        }
        var lines: [String] = []
        let earlier = messages[..<latestUser].filter { !$0.content.isEmpty && $0.role != "tool" }
        if !earlier.isEmpty {
            lines.append("Conversation so far:")
            for message in earlier {
                lines.append("\(message.role == "assistant" ? "Assistant" : "User"): \(message.content)")
            }
            lines.append("")
        }
        lines.append(messages[latestUser].content)
        for message in messages[messages.index(after: latestUser)...] {
            if let call = message.toolCall {
                lines.append("")
                lines.append("You called \(call.name) with \(call.arguments.compactJSON).")
            } else if message.role == "tool" {
                lines.append("It returned: \(message.content)")
            }
        }
        if messages[latestUser...].contains(where: { $0.role == "tool" }) {
            lines.append("")
            lines.append("Now reply to the user, or call another tool if you still need one.")
        }
        return lines.joined(separator: "\n")
    }
}

extension JSONValue {
    var compactJSON: String {
        guard let data = try? JSONEncoder().encode(self) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
