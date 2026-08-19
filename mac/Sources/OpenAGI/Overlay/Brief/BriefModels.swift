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

/// Stable reference to the store record behind a brief row. Optional because
/// an unbacked daily-plan focus is real UI content but has no durable record.
struct BriefEntityRef: Decodable, Equatable {
  let kind: String
  let id: String
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
  /// Secondary actions intended for a menu. Kept separate from `actions` so an
  /// older app ignores them instead of rendering every move target inline.
  let menuActions: [BriefAction]
  let deepLink: String
  let entityRef: BriefEntityRef?
  /// The row's full, verbatim current text, for an action that opens an inline
  /// editor (drafts: the draft body). nil = the daemon sent no seed, which is
  /// the ONLY signal that an editor must not be opened: `title` and `why` are a
  /// subject line and a summary, so falling back to either would submit a
  /// fragment of the draft over the whole draft.
  let editValue: String?

  // Decode defensively: a slightly newer or older daemon must never break the
  // popover. `id` is the only required field — everything else, including a
  // whole malformed action, degrades rather than throwing.
  enum CodingKeys: String, CodingKey { case id, kind, title, why, score, dueAt, source, actions, menuActions, deepLink, entityRef, editValue }

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
    menuActions = c.lenientArray(BriefAction.self, .menuActions)
    deepLink = c.lenient(String.self, .deepLink, or: "/")
    entityRef = c.lenient(BriefEntityRef.self, .entityRef)
    // Absent OR wrong-typed both land on nil, and nil disables the editor.
    // Degrading a seed we could not parse into "" would be the one failure mode
    // this field exists to prevent.
    editValue = c.lenient(String.self, .editValue)
  }
}

/// The small, non-content snapshot sent with a scoped Quick Ask. The daemon
/// resolves entityRef against its live stores; title/why are only a fallback
/// for an unbacked focus row.
struct BriefChatContext: Equatable {
  let kind: String
  let title: String
  let why: String
  let entityRef: BriefEntityRef?

  init(item: BriefItem) {
    kind = item.kind
    title = item.title
    why = item.why
    entityRef = item.entityRef
  }

  var jsonObject: [String: Any] {
    var value: [String: Any] = ["kind": kind, "title": title, "why": why]
    if let ref = entityRef { value["entityRef"] = ["kind": ref.kind, "id": ref.id] }
    return value
  }
}

/// Counts of renderable rows that did not fit in the brief, after the daemon
/// has applied the same eligibility filters used for visible rows.
struct BriefOlderBreakdown: Decodable, Equatable {
  let clarifications: Int
  let drafts: Int
  let tasks: Int
  let suggestions: Int

  enum CodingKeys: String, CodingKey { case clarifications, drafts, tasks, suggestions }
}

extension BriefOlderBreakdown {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    clarifications = max(0, c.lenient(Int.self, .clarifications, or: 0))
    drafts = max(0, c.lenient(Int.self, .drafts, or: 0))
    tasks = max(0, c.lenient(Int.self, .tasks, or: 0))
    suggestions = max(0, c.lenient(Int.self, .suggestions, or: 0))
  }
}

struct BriefOlder: Decodable, Equatable {
  let count: Int
  let oldestAt: String?
  /// Nil means an older daemon that only knows the aggregate `count`.
  let byKind: BriefOlderBreakdown?

  enum CodingKeys: String, CodingKey { case count, oldestAt, byKind }
}

extension BriefOlder {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    count = max(0, c.lenient(Int.self, .count, or: 0))
    oldestAt = c.lenient(String.self, .oldestAt)
    // Missing OR malformed is an older/unknown peer, not a reason to lose the
    // still-useful aggregate count.
    byKind = c.lenient(BriefOlderBreakdown.self, .byKind)
  }

  /// A truthful footer for both wire generations. The aggregate leads because
  /// it remains authoritative; additive kind counts explain that a large
  /// backlog may mostly be suggestions rather than unfinished tasks.
  var disclosureLabel: String {
    var parts = ["\(formattedBriefCount(count)) more \(count == 1 ? "item" : "items")"]
    if let byKind {
      appendBriefCount(byKind.clarifications, singular: "clarification", plural: "clarifications", to: &parts)
      appendBriefCount(byKind.drafts, singular: "draft", plural: "drafts", to: &parts)
      appendBriefCount(byKind.tasks, singular: "task", plural: "tasks", to: &parts)
      appendBriefCount(byKind.suggestions, singular: "suggestion", plural: "suggestions", to: &parts)
    }
    return parts.joined(separator: " · ")
  }
}

private func appendBriefCount(_ count: Int, singular: String, plural: String, to parts: inout [String]) {
  guard count > 0 else { return }
  parts.append("\(formattedBriefCount(count)) \(count == 1 ? singular : plural)")
}

private func formattedBriefCount(_ count: Int) -> String {
  NumberFormatter.localizedString(from: NSNumber(value: count), number: .decimal)
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
    older = c.lenient(BriefOlder.self, .older, or: BriefOlder(count: 0, oldestAt: nil, byKind: nil))
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
