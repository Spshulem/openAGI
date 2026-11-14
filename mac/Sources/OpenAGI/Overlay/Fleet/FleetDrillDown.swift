import Foundation

// The Supervisor tab's detail screen: any "Needs you" question or "In
// progress" thread opens it, with the chat's recent messages, the options,
// and a reply box. Pure pieces here, unit-tested; the state lives on
// FleetConsumer and the view in FleetDetailScreen.

/// What the detail screen shows. One at a time; nil is the lists.
enum FleetOpenItem: Equatable, Hashable {
  case question(String)
  case thread(String)

  /// The reply draft's and result's key: one per item.
  var key: String {
    switch self {
    case let .question(id): return "q:" + id
    case let .thread(key): return "t:" + key
    }
  }

  /// After a new state: the item while it is still open. A question that
  /// closed (answered, replied, dismissed) falls back to its thread, so the
  /// owner keeps reading the chat; else the screen goes back to the lists.
  static func reconcile(_ item: FleetOpenItem?, closedQuestion: FleetQuestion?, openIDs: Set<String>,
                        threadKeys: Set<String>) -> FleetOpenItem? {
    switch item {
    case nil: return nil
    case let .question(id):
      if openIDs.contains(id) { return item }
      if let key = closedQuestion?.threadKey, threadKeys.contains(key) { return .thread(key) }
      return nil
    case let .thread(key):
      return threadKeys.contains(key) ? item : nil
    }
  }
}

/// Where a typed reply goes.
enum FleetReplyTarget: Equatable {
  /// POST /fleet/api/questions/:id { reply }: the hub sends it and closes
  /// the question.
  case question(id: String)
  /// POST /fleet/api/send { threadKey, message }: the owner's own message.
  case thread(key: String)
  /// No reply box: the answer belongs in the agent's app (why says so).
  case none(why: String)

  /// A question with canReply goes through the question route. Without it,
  /// a question about one thread sends to that thread, except a risky one
  /// (only the hub's question route is held to typing it as the owner) and
  /// an app card or prompt (a typed message doesn't press its buttons).
  static func of(_ question: FleetQuestion) -> FleetReplyTarget {
    if question.canReply { return .question(id: question.id) }
    let app = (question.openChat ?? question.chats.first)?.appName ?? "the agent's app"
    if question.kind == "agent-card" || question.kind == "prompt" { return .none(why: "Answer it in \(app).") }
    if question.risky { return .none(why: "Answer this one in \(app), or with its buttons.") }
    guard let key = question.threadKey, !key.isEmpty else {
      return .none(why: question.allChats.count > 1 ? "This is about several chats. Open each one to reply." : "No chat to reply to.")
    }
    return .thread(key: key)
  }

  static func of(threadKey: String) -> FleetReplyTarget { .thread(key: threadKey) }

  var canSend: Bool {
    if case .none = self { return false }
    return true
  }

  /// The words to send, or nil when there are none or too many.
  static func message(_ draft: String) -> String? {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty || length(text) > maxLength ? nil : text
  }

  /// Measured as the hub measures it: JavaScript's UTF-16 length.
  static func length(_ text: String) -> Int { text.utf16.count }

  /// The hub's SEND_MAX and the question reply's cap.
  static let maxLength = 2000
}
