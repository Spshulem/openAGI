import Foundation

// The logic behind a Needs You ask that carries several independent
// questions (card.questionItems, src/fleet/decision-items.js). The views are
// in NeedsYouQuestionItemsView.swift; FleetConsumer owns the state.
//
// Rules kept here, on every surface:
// - Each question is answered on its own. There is no "answer all" or
//   "accept recommendations" action, and a blanket answer is never sent.
// - A recommendation is text. It is never preselected, never a draft, and
//   never sent unless the owner picks or types that answer themselves.
// - Only the owner's drafted answers and skips go out, in one request;
//   unanswered questions are left as they are.
// - Delivered and queued answers are read-only; a failed one keeps its answer
//   to retry.

/// The owner's unsent work on one question: a picked or typed answer, or a
/// skip for now. Persisted locally so a walkthrough can be resumed.
struct FleetQuestionItemDraft: Codable, Equatable {
  var answer: String? = nil
  var skipped: Bool = false

  var trimmedAnswer: String? {
    guard let text = answer?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    return text
  }

  var isEmpty: Bool { trimmedAnswer == nil && !skipped }
}

/// Drafts and the walkthrough position, saved per question id, each draft
/// under its item id: "openagi.fleet.questionItems.<questionId>" ->
/// { drafts: { <itemId>: draft }, position }.
struct FleetQuestionItemDraftStore {
  struct Saved: Codable, Equatable {
    var drafts: [String: FleetQuestionItemDraft] = [:]
    var position: Int? = nil
  }

  static let keyPrefix = "openagi.fleet.questionItems."
  let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func key(_ questionId: String) -> String { Self.keyPrefix + questionId }

  func load(_ questionId: String) -> Saved {
    guard let data = defaults.data(forKey: key(questionId)),
          let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return Saved() }
    return Saved(drafts: saved.drafts.filter { !$0.value.isEmpty }, position: saved.position)
  }

  func save(_ saved: Saved, for questionId: String) {
    let kept = Saved(drafts: saved.drafts.filter { !$0.value.isEmpty }, position: saved.position)
    guard !kept.drafts.isEmpty || kept.position != nil, let data = try? JSONEncoder().encode(kept) else {
      defaults.removeObject(forKey: key(questionId))
      return
    }
    defaults.set(data, forKey: key(questionId))
  }

  func clear(_ questionId: String) {
    defaults.removeObject(forKey: key(questionId))
  }
}

/// One answer_items request: only the drafted answers and the new skips.
struct FleetAnswerItemsRequest: Equatable {
  struct Answer: Equatable {
    let itemId: String
    let answer: String
  }

  var answers: [Answer] = []
  var skip: [String] = []

  var isEmpty: Bool { answers.isEmpty && skip.isEmpty }
  var itemIds: [String] { answers.map(\.itemId) + skip }

  /// POST /fleet/api/cards/:id/act body. No group text, no option value:
  /// each answer is tied to its own item.
  var body: [String: Any] {
    [
      "op": "answer_items",
      "items": answers.map { ["itemId": $0.itemId, "answer": $0.answer] },
      "skip": skip,
    ]
  }
}

/// How one question reads in a list: its badge and colour.
enum FleetQuestionItemBadge: Equatable {
  case notAnswered
  case draft
  case skipForNow
  case skipped
  case queued
  case delivered
  case failed
  case unknown

  var text: String {
    switch self {
    case .notAnswered: return "Not answered"
    case .draft: return "Draft, not sent"
    case .skipForNow: return "Skip, not sent"
    case .skipped: return "Skipped"
    case .queued: return "Queued"
    case .delivered: return "Delivered"
    case .failed: return "Failed"
    case .unknown: return "Status unknown"
    }
  }
}

enum FleetQuestionItemsLogic {
  /// The hub caps each answer at this many characters.
  static let answerMax = 1200

  /// Unanswered, skipped and failed questions can be answered; delivered and
  /// queued ones are read-only, as is a status this build doesn't know.
  static func isEditable(_ item: FleetQuestionItem) -> Bool {
    [.unanswered, .skipped, .failed].contains(item.state.status)
  }

  /// The answer that would go out for this question: the owner's draft, or a
  /// failed answer the hub kept. Never the recommendation.
  static func pendingAnswer(_ item: FleetQuestionItem, draft: FleetQuestionItemDraft?) -> String? {
    guard isEditable(item) else { return nil }
    if let text = draft?.trimmedAnswer { return text }
    if draft?.skipped == true { return nil }
    if item.state.status == .failed, let kept = item.state.answer?.trimmingCharacters(in: .whitespacesAndNewlines), !kept.isEmpty {
      return kept
    }
    return nil
  }

  /// "Answer all questions", "Approve recommended choices" and the like: a
  /// reply to the whole group, never an answer to one question. Mirrors the
  /// hub's GROUP_OPTION_RE.
  static func isGroupAnswer(_ text: String) -> Bool {
    let pattern = #"^\s*(?:answer\s+(?:all|every|each)(?:\s+(?:the|of\s+the))?\s+questions?|approve\s+(?:all\s+)?(?:the\s+)?recommend(?:ed|ations?)(?:\s+(?:choices|options|answers))?|accept\s+(?:all\s+)?(?:the\s+)?recommend(?:ed|ations?)(?:\s+choices)?|approve\s+all|answer\s+questions?|resolve\s+(?:all\s+)?(?:release\s+)?decisions)\s*$"#
    return text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
  }

  /// The request for these drafts: each editable question with an answer,
  /// then each one marked "skip for now" that the hub has not already
  /// recorded as skipped. `only` limits it (Retry sends one question).
  static func request(items: [FleetQuestionItem], drafts: [String: FleetQuestionItemDraft], only: Set<String>? = nil) -> FleetAnswerItemsRequest {
    var out = FleetAnswerItemsRequest()
    for item in items where isEditable(item) && (only?.contains(item.itemId) ?? true) {
      let draft = drafts[item.itemId]
      if let answer = pendingAnswer(item, draft: draft), !isGroupAnswer(answer) {
        out.answers.append(.init(itemId: item.itemId, answer: String(answer.prefix(answerMax))))
      } else if draft?.skipped == true, item.state.status != .skipped {
        out.skip.append(item.itemId)
      }
    }
    return out
  }

  static func badge(_ item: FleetQuestionItem, draft: FleetQuestionItemDraft?) -> FleetQuestionItemBadge {
    switch item.state.status {
    case .delivered: return .delivered
    case .queued: return .queued
    case .failed: return .failed
    case .unknown: return .unknown
    case .skipped:
      return draft?.trimmedAnswer != nil ? .draft : .skipped
    case .unanswered:
      if draft?.trimmedAnswer != nil { return .draft }
      if draft?.skipped == true { return .skipForNow }
      return .notAnswered
    }
  }

  /// Where a walkthrough opens: its saved position, else the first question
  /// still open with nothing drafted, else the first open one, else the top.
  static func startIndex(items: [FleetQuestionItem], drafts: [String: FleetQuestionItemDraft], saved: Int? = nil) -> Int {
    if let saved, items.indices.contains(saved) { return saved }
    if let i = items.firstIndex(where: { isEditable($0) && (drafts[$0.itemId]?.isEmpty ?? true) && $0.state.status != .skipped }) { return i }
    if let i = items.firstIndex(where: isEditable) { return i }
    return 0
  }

  /// "3 of 10".
  static func progress(index: Int, total: Int) -> String {
    "\(min(max(index, 0), max(total - 1, 0)) + 1) of \(total)"
  }

  /// Questions still open: not delivered or queued.
  static func openCount(_ items: [FleetQuestionItem]) -> Int {
    items.filter(isEditable).count + items.filter { $0.state.status == .unknown }.count
  }

  /// The hub's "Review N questions" label, else one counted here. Never a
  /// label that would read as an answer.
  static func reviewLabel(_ card: FleetCardBrief) -> String {
    if let action = card.primaryAction, action.op == "review_items",
       let label = action.label?.trimmingCharacters(in: .whitespacesAndNewlines), label.lowercased().hasPrefix("review") {
      return label
    }
    let open = openCount(card.questionItems)
    let n = open > 0 ? open : card.questionItems.count
    return "Review \(n) question\(n == 1 ? "" : "s")"
  }

  /// "Send 3 answers", "Send 1 answer · skip 2", "Skip 2 for now".
  static func sendLabel(_ request: FleetAnswerItemsRequest) -> String {
    let a = request.answers.count
    let s = request.skip.count
    if a == 0 && s == 0 { return "Send answers" }
    if a == 0 { return "Skip \(s) for now" }
    let base = "Send \(a) answer\(a == 1 ? "" : "s")"
    return s > 0 ? "\(base) · skip \(s)" : base
  }

  /// "10 questions · 1 delivered · 1 failed · 1 skipped".
  static func summaryLine(_ items: [FleetQuestionItem]) -> String {
    var parts = ["\(items.count) question\(items.count == 1 ? "" : "s")"]
    let counts: [(FleetQuestionItemState.Status, String)] = [(.delivered, "delivered"), (.queued, "queued"), (.failed, "failed"), (.skipped, "skipped")]
    for (status, word) in counts {
      let n = items.filter { $0.state.status == status }.count
      if n > 0 { parts.append("\(n) \(word)") }
    }
    let open = items.filter { $0.state.status == .unanswered }.count
    if open > 0 && open < items.count { parts.append("\(open) not answered") }
    return parts.joined(separator: " · ")
  }

  /// What one answer_items call did, in the owner's words.
  static func outcome(_ result: FleetCardActResponse.Result?) -> FleetNote {
    guard let result else { return FleetNote(text: "The supervisor didn't say what happened. Check each question's state.", isError: true) }
    let detail = result.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
    switch result.status {
    case "delivered": return FleetNote(text: detail ?? "Answers delivered to the agent.", isError: false)
    case "queued": return FleetNote(text: detail ?? "Answers queued; they go once the Mac can type.", isError: false)
    case "skipped": return FleetNote(text: detail ?? "Skipped questions stay open.", isError: false)
    case "failed": return FleetNote(text: sentence(detail ?? "Couldn't deliver the answers") + " Your answers are kept to retry.", isError: true)
    default: return FleetNote(text: detail ?? (result.ok ? "Done." : "The supervisor couldn't take those answers."), isError: !result.ok)
    }
  }

  /// "host offline" -> "host offline."
  static func sentence(_ text: String) -> String {
    guard let last = text.last, !".!?".contains(last) else { return text }
    return text + "."
  }

  /// The drafts left after a send: answers the hub delivered, queued or
  /// recorded as skipped are cleared; a failed answer stays to retry.
  static func draftsAfterSend(_ drafts: [String: FleetQuestionItemDraft], sent: FleetAnswerItemsRequest, items: [FleetQuestionItem]) -> [String: FleetQuestionItemDraft] {
    var out = drafts
    let byId = Dictionary(items.map { ($0.itemId, $0) }, uniquingKeysWith: { first, _ in first })
    for answer in sent.answers {
      switch byId[answer.itemId]?.state.status {
      case .delivered?, .queued?: out[answer.itemId] = nil
      case .failed?, nil:
        // Keep exactly what was sent, to retry.
        out[answer.itemId] = FleetQuestionItemDraft(answer: answer.answer, skipped: false)
      default: break
      }
    }
    for id in sent.skip where byId[id]?.state.status == .skipped {
      out[id] = nil
    }
    return out
  }

  /// Drafts that no longer apply: a question delivered or queued elsewhere.
  static func pruned(_ drafts: [String: FleetQuestionItemDraft], items: [FleetQuestionItem]) -> [String: FleetQuestionItemDraft] {
    let editable = Set(items.filter(isEditable).map(\.itemId))
    return drafts.filter { editable.contains($0.key) && !$0.value.isEmpty }
  }
}
