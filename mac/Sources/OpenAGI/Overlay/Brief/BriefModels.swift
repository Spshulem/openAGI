import Foundation

// Wire shapes for GET /brief/today. Actions are DECLARATIVE — the server
// sends method+path+body so the client can dispatch any item kind without a
// per-kind lookup table, and a new server-side source needs no Swift change.
//
// Every decode below is version-skew tolerant, and that is a REQUIREMENT, not
// politeness: DaemonController adopts an already-running daemon on
// 127.0.0.1:43210 (common when the user runs `npm run serve` in a terminal
// next to the .app), so an app of one version routinely decodes a daemon of
// another. Two rules hold everywhere in this file:
//   1. a field the peer renamed or retyped costs that FIELD, not the object;
//   2. an element this build can't parse costs that ELEMENT, not the response.
// Rule 2 is the one that used to be broken: a single malformed action threw
// out of BriefItem.init, out of BriefResponse.init, and took every item plus
// older/degraded/generatedAt with it — the popover then said "Nothing needs
// you right now." next to a raw Foundation error string.

/// Decodes `T`, or nothing at all. Wrapping array elements in this turns "one
/// bad element" into a `nil` hole instead of an error that unwinds the whole
/// response. The throw is caught inside the element's own decoder, so the
/// enclosing unkeyed container still advances one element per iteration.
private struct Lossy<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

fileprivate extension KeyedDecodingContainer {
  /// Missing OR wrong-typed -> `fallback`. `decodeIfPresent` alone only covers
  /// missing; a key whose type changed still throws and kills the object.
  func lenient<T: Decodable>(_ type: T.Type, _ key: Key, or fallback: T) -> T {
    (try? decodeIfPresent(type, forKey: key)) ?? fallback
  }

  /// Missing OR wrong-typed -> nil.
  func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
    try? decodeIfPresent(type, forKey: key)
  }

  /// Elements decode independently: the ones this build can't parse drop out,
  /// the rest survive. A key that isn't an array at all yields [].
  func lenientArray<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
    guard let boxed = try? decodeIfPresent([Lossy<T>].self, forKey: key) else { return [] }
    return boxed.compactMap { $0.value }
  }
}

struct BriefAction: Decodable, Equatable, Identifiable {
  let id: String
  let label: String
  let style: String     // primary | secondary | destructive | revise
  let method: String    // POST | PATCH | DELETE
  let path: String
  let body: [String: AnyCodable]?
  /// Name of the body key an inline text field should fill before dispatch
  /// (a later phase uses it for draft revision); nil = the action takes no input.
  let bodyField: String?

  enum CodingKeys: String, CodingKey { case id, label, style, method, path, body, bodyField }
}

// init(from:) lives in an extension ON PURPOSE: declaring it in the body above
// would suppress the synthesized memberwise init that previews and tests use.
extension BriefAction {
  /// Only id/method/path are required — they are the three the client cannot
  /// invent. Presentation (label, style) degrades to something usable.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    method = try c.decode(String.self, forKey: .method)
    path = try c.decode(String.self, forKey: .path)
    label = c.lenient(String.self, .label, or: id)
    style = c.lenient(String.self, .style, or: "secondary")
    body = c.lenient([String: AnyCodable].self, .body)
    bodyField = c.lenient(String.self, .bodyField)
  }
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
  /// The row's full, verbatim current text, for an action that opens an inline
  /// editor (drafts: the draft body). nil = the daemon sent no seed, which is
  /// the ONLY signal that an editor must not be opened: `title` and `why` are a
  /// subject line and a summary, so falling back to either would submit a
  /// fragment of the draft over the whole draft.
  let editValue: String?

  // Decode defensively: a slightly newer or older daemon must never break the
  // popover. `id` is the only required field — everything else, including a
  // whole malformed action, degrades rather than throwing.
  enum CodingKeys: String, CodingKey { case id, kind, title, why, score, dueAt, source, actions, deepLink, editValue }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = c.lenient(String.self, .kind, or: "task")
    title = c.lenient(String.self, .title, or: "(untitled)")
    why = c.lenient(String.self, .why, or: "")
    score = c.lenient(Double.self, .score, or: 0)
    dueAt = c.lenient(String.self, .dueAt)
    source = c.lenient(String.self, .source, or: "unknown")
    actions = c.lenientArray(BriefAction.self, .actions)
    deepLink = c.lenient(String.self, .deepLink, or: "/")
    // Absent OR wrong-typed both land on nil, and nil disables the editor.
    // Degrading a seed we could not parse into "" would be the one failure mode
    // this field exists to prevent.
    editValue = c.lenient(String.self, .editValue)
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
    items = c.lenientArray(BriefItem.self, .items)
    older = c.lenient(BriefOlder.self, .older, or: BriefOlder(count: 0, oldestAt: nil))
    generatedAt = c.lenient(String.self, .generatedAt)
    planCachedAt = c.lenient(String.self, .planCachedAt)
    degraded = c.lenientArray(String.self, .degraded)
  }
}

/// Minimal JSON value box so an action's `body` can round-trip back out to the
/// daemon verbatim without the client needing to know its schema.
struct AnyCodable: Codable, Equatable {
  let value: Any

  init(_ value: Any) {
    // Never double-box: AnyCodable(AnyCodable(x)) would encode as null.
    if let boxed = value as? AnyCodable { self.value = boxed.value } else { self.value = value }
  }

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
    case is NSNull: try c.encodeNil()
    case let v as Bool: try c.encode(v)
    case let v as Int: try c.encode(v)
    case let v as Double: try c.encode(v)
    case let v as String: try c.encode(v)
    // Containers used to fall through to encodeNil, so a body of
    // {"patch": {...}, "ids": [1,2]} went back to the daemon as
    // {"patch": null, "ids": null}. Nested values re-enter this switch.
    case let v as [String: Any]: try c.encode(v.mapValues { AnyCodable($0) })
    case let v as [Any]: try c.encode(v.map { AnyCodable($0) })
    default: try c.encodeNil()
    }
  }

  static func == (a: AnyCodable, b: AnyCodable) -> Bool { "\(a.value)" == "\(b.value)" }
}
