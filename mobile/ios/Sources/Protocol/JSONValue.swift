import Foundation

// A handful of the daemon's responses carry genuinely arbitrary JSON --
// a pending action's `args` are whatever shape the invoked tool takes, its
// `result` is whatever that tool returned, a task's `sourceMeta` is
// per-source metadata. Modelling each of those as a concrete Swift type
// would mean inventing a schema the daemon never promised; this decodes
// (and re-encodes, for display) any JSON value losslessly instead.
public indirect enum JSONValue: Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public extension JSONValue {
    // A short, human-readable rendering for a detail screen -- the Inbox's
    // approval detail shows a pending action's raw `args` this way rather
    // than pretty-printing raw JSON.
    var displayDescription: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .array(let values): return "[" + values.map(\.displayDescription).joined(separator: ", ") + "]"
        case .object(let fields):
            return fields.keys.sorted()
                .map { "\($0): \(fields[$0]!.displayDescription)" }
                .joined(separator: "\n")
        }
    }
}
