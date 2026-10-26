import Foundation

/// Attention is not the size of the durable notification log. Informational
/// history remains in the panel; approvals and canonical current queues stay
/// authoritative regardless of age.
enum AttentionBadge {
  static let notificationWindow: TimeInterval = 7 * 24 * 60 * 60

  static func count(
    briefKeys: [String], outreach: [OutreachItem], approvalIDs: [String],
    fleetIDs: [String], now: Date = Date()
  ) -> Int {
    var keys = Set(briefKeys)
    keys.formUnion(approvalIDs.map { "pending-action:\($0)" })
    keys.formUnion(fleetIDs.map { "fleet:\($0)" })
    for item in outreach where needsAttention(item, now: now) {
      if let kind = item.sourceKind, let id = item.sourceId {
        keys.insert("\(kind):\(id)")
      } else {
        keys.insert("outreach:\(item.id)")
      }
    }
    return keys.count
  }

  static func needsAttention(_ item: OutreachItem, now: Date = Date()) -> Bool {
    guard ["unseen", "seen", "error"].contains(item.status), item.needsDecision,
      item.type != "digest", item.type != "pending-action" else { return false }
    // Remote coding approvals have no local canonical copy. Never age out an
    // approval merely because its notification is old.
    if item.type == "coding-approval" { return true }
    guard let createdAt = item.createdAt else { return false }
    let age = now.timeIntervalSince(createdAt)
    return age >= 0 && age <= notificationWindow
  }

  static func label(_ count: Int) -> String { count > 99 ? "99+" : String(count) }
}
