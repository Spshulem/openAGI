import Foundation

// Wire shapes for the proactive-outreach feed exposed by the remote "main"
// Distiller. An OutreachItem is one durable, cursor-indexed unit of proactive
// output (a draft, suggestion, stalled-task decision, etc). `seq` is the
// monotonic cursor the consumer tracks so delivery is lossless across restarts.

struct OutreachItem: Identifiable, Decodable, Equatable {
  let id: String
  let seq: Int
  let type: String
  let title: String
  let summary: String
  let needsDecision: Bool
  let actions: [String]
  let status: String
  /// Where the item came from, e.g. kind "fleet" and a supervisor question id.
  /// The Supervisor tab uses it to hide only the copies of its own questions.
  let sourceKind: String?
  let sourceId: String?

  // The server item carries more fields (createdAt, …); we only decode what
  // the Mac surfaces. Missing optional-ish fields decode to sane defaults so
  // a slightly newer/older server never breaks the client.
  enum CodingKeys: String, CodingKey {
    case id, seq, type, title, summary, needsDecision, actions, status, sourceRef
  }

  private struct SourceRef: Decodable {
    let kind: String?
    let id: String?

    enum CodingKeys: String, CodingKey { case kind, id }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      kind = try? c.decodeIfPresent(String.self, forKey: .kind)
      id = try? c.decodeIfPresent(String.self, forKey: .id)
    }
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
    type = try c.decodeIfPresent(String.self, forKey: .type) ?? "unknown"
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
    needsDecision = try c.decodeIfPresent(Bool.self, forKey: .needsDecision) ?? false
    actions = try c.decodeIfPresent([String].self, forKey: .actions) ?? []
    status = try c.decodeIfPresent(String.self, forKey: .status) ?? "unseen"
    let source = try? c.decodeIfPresent(SourceRef.self, forKey: .sourceRef)
    sourceKind = source?.kind
    sourceId = source?.id
  }
}

struct OutreachFeedResponse: Decodable {
  let items: [OutreachItem]
  let cursor: Int
}
