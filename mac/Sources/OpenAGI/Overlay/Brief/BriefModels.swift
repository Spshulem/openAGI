import Foundation

// Wire shapes for GET /brief/today. Actions are DECLARATIVE — the server
// sends method+path+body so the client can dispatch any item kind without a
// per-kind lookup table, and a new server-side source needs no Swift change.

struct BriefAction: Decodable, Equatable, Identifiable {
  let id: String
  let label: String
  let style: String     // primary | secondary | destructive | revise
  let method: String    // POST | PATCH | DELETE
  let path: String
  let body: [String: AnyCodable]?
}

struct BriefItem: Decodable, Equatable, Identifiable {
  let id: String
  let kind: String      // focus | task | suggestion | draft | clarification
  let title: String
  let why: String
  let score: Double
  let dueAt: String?
  let source: String
  let actions: [BriefAction]
  let deepLink: String

  // Decode defensively: a slightly newer or older daemon must never break the
  // popover. Only id/kind/title are required.
  enum CodingKeys: String, CodingKey { case id, kind, title, why, score, dueAt, source, actions, deepLink }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "task"
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? "(untitled)"
    why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
    score = try c.decodeIfPresent(Double.self, forKey: .score) ?? 0
    dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt)
    source = try c.decodeIfPresent(String.self, forKey: .source) ?? "unknown"
    actions = try c.decodeIfPresent([BriefAction].self, forKey: .actions) ?? []
    deepLink = try c.decodeIfPresent(String.self, forKey: .deepLink) ?? "/"
  }
}

struct BriefOlder: Decodable, Equatable {
  let count: Int
  let oldestAt: String?
}

struct BriefResponse: Decodable, Equatable {
  let items: [BriefItem]
  let older: BriefOlder
  let generatedAt: String?
  let planCachedAt: String?
  let degraded: [String]

  enum CodingKeys: String, CodingKey { case items, older, generatedAt, planCachedAt, degraded }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    items = try c.decodeIfPresent([BriefItem].self, forKey: .items) ?? []
    older = try c.decodeIfPresent(BriefOlder.self, forKey: .older) ?? BriefOlder(count: 0, oldestAt: nil)
    generatedAt = try c.decodeIfPresent(String.self, forKey: .generatedAt)
    planCachedAt = try c.decodeIfPresent(String.self, forKey: .planCachedAt)
    degraded = try c.decodeIfPresent([String].self, forKey: .degraded) ?? []
  }
}

/// Minimal JSON value box so an action's `body` can round-trip back out to the
/// daemon verbatim without the client needing to know its schema.
struct AnyCodable: Codable, Equatable {
  let value: Any

  init(_ value: Any) { self.value = value }

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let v = try? c.decode(Bool.self) { value = v }
    else if let v = try? c.decode(Int.self) { value = v }
    else if let v = try? c.decode(Double.self) { value = v }
    else if let v = try? c.decode(String.self) { value = v }
    else if let v = try? c.decode([String: AnyCodable].self) { value = v.mapValues { $0.value } }
    else if let v = try? c.decode([AnyCodable].self) { value = v.map { $0.value } }
    else { value = NSNull() }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch value {
    case let v as Bool: try c.encode(v)
    case let v as Int: try c.encode(v)
    case let v as Double: try c.encode(v)
    case let v as String: try c.encode(v)
    default: try c.encodeNil()
    }
  }

  static func == (a: AnyCodable, b: AnyCodable) -> Bool { "\(a.value)" == "\(b.value)" }
}
