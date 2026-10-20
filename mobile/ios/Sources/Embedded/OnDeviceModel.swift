import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif
#if os(iOS)
import UIKit
#endif

// Shared by the iPhone and Mac apps. Read actual system availability;
// OS support alone does not mean the model is enabled or downloaded.
enum OnDeviceModelStatus: Equatable, Sendable {
    case available
    // Apple Intelligence is supported but switched off in Settings.
    case notEnabled
    // Enabled; the model is still downloading.
    case downloading
    // Not an Apple Intelligence iPhone, or iOS older than 26.
    case unsupported

    var availabilityName: String {
        switch self {
        case .available: return "available"
        case .notEnabled: return "not-enabled"
        case .downloading: return "downloading"
        case .unsupported: return "unsupported"
        }
    }

    @MainActor
    static func current() -> OnDeviceModelStatus {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return .available
            case .unavailable(.appleIntelligenceNotEnabled): return .notEnabled
            case .unavailable(.modelNotReady): return .downloading
            case .unavailable: return .unsupported
            }
        }
        #endif
        return .unsupported
    }

    // The backend the bridge answers with: Foundation Models when it can run,
    // otherwise one that fails each generation with a plain message.
    @MainActor
    static func backend() -> any DeviceModelBackend {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *), current() == .available {
            return FoundationModelsBackend()
        }
        #endif
        return UnavailableModelBackend()
    }
}

struct UnavailableModelBackend: DeviceModelBackend {
    var modelName: String { "unavailable" }
    func contextSize() async -> Int { 4096 }
    func generate(_ request: DeviceGenerateRequest, onDelta: @escaping @Sendable (String) -> Void) async throws -> DeviceGenerateResult {
        throw DeviceModelFailure.unavailable
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
struct FoundationModelsBackend: DeviceModelBackend {
    var modelName: String { "apple-foundation-models" }

    func contextSize() async -> Int {
        // The system model's window is 4096 tokens on iOS 26.
        4096
    }

    func generate(_ request: DeviceGenerateRequest, onDelta: @escaping @Sendable (String) -> Void) async throws -> DeviceGenerateResult {
        // A tool call goes back to the daemon, which runs it and asks again:
        // each daemon tool is declared here with a body that stops the
        // session and hands the call over.
        let tools: [any Tool] = request.tools.compactMap { try? HandoffTool($0) }
        let session = LanguageModelSession(model: .default, tools: tools, instructions: Instructions(request.system))
        let prompt = DeviceModelPrompt.render(request.messages)
        let options = GenerationOptions(maximumResponseTokens: request.maxOutputTokens)
        do {
            // Apple rate-limits streaming harder in the background; a single
            // response there, live streaming in the foreground.
            if await Self.isForeground() {
                var sent = ""
                for try await snapshot in session.streamResponse(to: prompt, options: options) {
                    let text = snapshot.content
                    if text.hasPrefix(sent), text.count > sent.count {
                        onDelta(String(text.dropFirst(sent.count)))
                        sent = text
                    }
                }
                return .text(sent)
            }
            return .text(try await session.respond(to: prompt, options: options).content)
        } catch let error as LanguageModelSession.ToolCallError {
            if let handoff = error.underlyingError as? ToolHandoff { return .toolCall(handoff.call) }
            throw DeviceModelFailure(code: "device-model-error", message: error.localizedDescription)
        } catch let error as LanguageModelSession.GenerationError {
            throw Self.failure(for: error)
        }
    }

    private static func failure(for error: LanguageModelSession.GenerationError) -> DeviceModelFailure {
        switch error {
        case .rateLimited:
            return DeviceModelFailure(code: "device-model-throttled", message: "This device is limiting on-device AI right now. Try again in a moment.")
        case .exceededContextWindowSize:
            return DeviceModelFailure(code: "device-model-context", message: "That conversation is too long for the on-device model. Start a new one.")
        case .guardrailViolation:
            return DeviceModelFailure(code: "device-model-refused", message: "The on-device model declined to answer that.")
        case .assetsUnavailable:
            return .unavailable
        default:
            return DeviceModelFailure(code: "device-model-error", message: error.localizedDescription)
        }
    }

    @MainActor
    private static func isForeground() -> Bool {
        #if os(iOS)
        UIApplication.shared.applicationState == .active
        #else
        true
        #endif
    }
}

@available(iOS 26.0, macOS 26.0, *)
private struct ToolHandoff: Error {
    let call: DeviceToolCall
}

// One daemon tool, declared to the model from its JSON Schema.
@available(iOS 26.0, macOS 26.0, *)
private struct HandoffTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema

    init(_ tool: DeviceModelTool) throws {
        name = tool.name
        description = tool.description
        parameters = try GenerationSchema(root: JSONSchemaMapping.schema(named: tool.name, from: tool.parameters), dependencies: [])
    }

    func call(arguments: GeneratedContent) async throws -> String {
        let json = (try? JSONDecoder().decode(JSONValue.self, from: Data(arguments.jsonString.utf8))) ?? .object([:])
        throw ToolHandoff(call: DeviceToolCall(name: name, arguments: json))
    }
}

// JSON Schema (the subset tool declarations use) to a Foundation Models
// schema. Anything it doesn't recognize becomes a string, which the model
// can always produce and the daemon's tool validates anyway.
@available(iOS 26.0, macOS 26.0, *)
enum JSONSchemaMapping {
    static func schema(named name: String, from json: JSONValue) -> DynamicGenerationSchema {
        guard case .object(let object) = json else { return DynamicGenerationSchema(type: String.self) }
        let description = object["description"].flatMap { if case .string(let text) = $0 { return text } else { return nil } }
        if case .array(let options)? = object["enum"] {
            let choices = options.compactMap { if case .string(let text) = $0 { return text } else { return nil } }
            if !choices.isEmpty { return DynamicGenerationSchema(name: name, description: description, anyOf: choices) }
        }
        switch object["type"] {
        case .string("object")?:
            let required: Set<String> = {
                guard case .array(let names)? = object["required"] else { return [] }
                return Set(names.compactMap { if case .string(let text) = $0 { return text } else { return nil } })
            }()
            var properties: [DynamicGenerationSchema.Property] = []
            if case .object(let declared)? = object["properties"] {
                for key in declared.keys.sorted() {
                    let propertyDescription = declared[key].flatMap { value -> String? in
                        guard case .object(let fields) = value, case .string(let text)? = fields["description"] else { return nil }
                        return text
                    }
                    properties.append(DynamicGenerationSchema.Property(
                        name: key,
                        description: propertyDescription,
                        schema: schema(named: "\(name)_\(key)", from: declared[key] ?? .null),
                        isOptional: !required.contains(key)
                    ))
                }
            }
            return DynamicGenerationSchema(name: name, description: description, properties: properties)
        case .string("array")?:
            return DynamicGenerationSchema(arrayOf: schema(named: "\(name)_item", from: object["items"] ?? .null))
        case .string("integer")?:
            return DynamicGenerationSchema(type: Int.self)
        case .string("number")?:
            return DynamicGenerationSchema(type: Double.self)
        case .string("boolean")?:
            return DynamicGenerationSchema(type: Bool.self)
        default:
            return DynamicGenerationSchema(type: String.self)
        }
    }
}
#endif
