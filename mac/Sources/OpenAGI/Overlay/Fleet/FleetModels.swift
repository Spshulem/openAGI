import Foundation

// Wire shapes for the local daemon's /fleet/api/* routes (src/fleet/routes.js).
//
// Same version-skew rules as BriefModels: the app routinely talks to a daemon
// of another version, so a renamed or retyped field costs that FIELD, and one
// question this build can't parse costs that QUESTION, never the whole state.

/// Decodes `T`, or nothing at all. See BriefModels' twin for why array
/// elements are wrapped in this.
private struct Lossy<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// One open "needs you" question from the coding-agent supervisor.
struct FleetQuestion: Decodable, Equatable, Identifiable {
  let id: String
  let kind: String?
  let title: String
  let body: String
  /// The fixed answers the supervisor offers. "dismiss" is dropped here: the
  /// row has its own Dismiss button, and a second one would be the same action.
  let options: [String]
  let threadKey: String?
  let prRef: String?
  let reviewReason: String?
  let reviewCategory: String?
  let pinned: Bool
  let createdAt: String?

  enum CodingKeys: String, CodingKey {
    case id, kind, title, body, options, threadKey, prRef, reviewReason, reviewCategory, pinned, createdAt
  }

  /// Why the supervisor's review kept it, or the close the owner overrode
  /// with Reopen. Same wording as the /fleet page.
  var reviewNote: String? {
    guard let reason = reviewReason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else {
      return nil
    }
    if pinned, let category = reviewCategory, category != "live" {
      return "You reopened it. The supervisor had said: \(reason)"
    }
    return "Supervisor: \(reason)"
  }
}

extension FleetQuestion {
  /// Options the owner can tap. "open thread" is left out: the supervisor
  /// can't carry it to the agent and always hands it back.
  var tappableOptions: [String] { options.filter { $0 != Self.openThread } }

  /// True when the answer has to be typed in the agent's own app.
  var answersInThread: Bool { options.contains(Self.openThread) }

  static let openThread = "open thread"

  /// "on it" -> "On it" for the supervisor's own fixed answers. An agent's
  /// own choices stay exactly as the agent wrote them (branch names, paths).
  func label(for option: String) -> String {
    guard kind != "agent-ask", let first = option.first else { return option }
    return first.uppercased() + option.dropFirst()
  }
}

/// What the last answer or dismissal of one question did, shown in its row.
struct FleetNote: Equatable {
  let text: String
  let isError: Bool
}

// init(from:) in an extension keeps the synthesized memberwise init.
extension FleetQuestion {
  /// Only `id` is required: it is the one thing the client cannot invent.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try? c.decodeIfPresent(String.self, forKey: .kind)
    title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "(untitled)"
    body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
    let rawOptions = (try? c.decodeIfPresent([Lossy<String>].self, forKey: .options)) ?? []
    options = rawOptions.compactMap { $0.value }.filter { !$0.isEmpty && $0 != "dismiss" }
    threadKey = try? c.decodeIfPresent(String.self, forKey: .threadKey)
    prRef = try? c.decodeIfPresent(String.self, forKey: .prRef)
    reviewReason = try? c.decodeIfPresent(String.self, forKey: .reviewReason)
    reviewCategory = try? c.decodeIfPresent(String.self, forKey: .reviewCategory)
    pinned = (try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
    createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
  }
}

/// The supervisor's health, without its questions. Equatable so the overlay
/// can watch it for height changes (the "Last scan failed" row).
struct FleetStatus: Equatable {
  let mode: String
  let enabled: Bool
  let running: Bool
  let lastTickAt: String?
  let lastError: String?
}

/// GET /fleet/api/state, trimmed to what the overlay shows.
struct FleetState: Decodable, Equatable {
  let mode: String
  let enabled: Bool
  let running: Bool
  let lastTickAt: String?
  let lastError: String?
  let questions: [FleetQuestion]

  enum CodingKeys: String, CodingKey { case mode, enabled, running, lastTickAt, lastError, questions }

  var status: FleetStatus {
    FleetStatus(mode: mode, enabled: enabled, running: running, lastTickAt: lastTickAt, lastError: lastError)
  }
}

extension FleetState {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? "observe"
    enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
    running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
    lastTickAt = try? c.decodeIfPresent(String.self, forKey: .lastTickAt)
    lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
    let raw = (try? c.decodeIfPresent([Lossy<FleetQuestion>].self, forKey: .questions)) ?? []
    questions = raw.compactMap { $0.value }
  }
}

struct FleetDelivery: Decodable, Equatable {
  let status: String?
  let detail: String?

  enum CodingKeys: String, CodingKey { case status, detail }

  init(status: String?, detail: String?) {
    self.status = status
    self.detail = detail
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    status = try? c.decodeIfPresent(String.self, forKey: .status)
    detail = try? c.decodeIfPresent(String.self, forKey: .detail)
  }
}

/// POST /fleet/api/questions/:id -> { question, delivery, state }.
struct FleetQuestionResponse: Decodable {
  struct Question: Decodable, Equatable {
    let id: String?
    let status: String?

    enum CodingKeys: String, CodingKey { case id, status }

    init(id: String?, status: String?) {
      self.id = id
      self.status = status
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try? c.decodeIfPresent(String.self, forKey: .id)
      status = try? c.decodeIfPresent(String.self, forKey: .status)
    }
  }

  let question: Question?
  let delivery: FleetDelivery?
  let state: FleetState?

  enum CodingKeys: String, CodingKey { case question, delivery, state }

  init(question: Question?, delivery: FleetDelivery?, state: FleetState?) {
    self.question = question
    self.delivery = delivery
    self.state = state
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    question = try? c.decodeIfPresent(Question.self, forKey: .question)
    delivery = try? c.decodeIfPresent(FleetDelivery.self, forKey: .delivery)
    state = try? c.decodeIfPresent(FleetState.self, forKey: .state)
  }
}

/// Every non-200 fleet route answers { error }, and a failed scan adds { state }.
struct FleetErrorBody: Decodable {
  let error: String?
  let state: FleetState?

  enum CodingKeys: String, CodingKey { case error, state }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    error = try? c.decodeIfPresent(String.self, forKey: .error)
    state = try? c.decodeIfPresent(FleetState.self, forKey: .state)
  }
}

extension BriefChatContext {
  /// Chat about one supervisor question. The daemon resolves the id against
  /// the live supervisor; title/why here are never sent to the model.
  init(question: FleetQuestion) {
    kind = "fleet"
    title = question.title
    why = question.body
    entityRef = BriefEntityRef(kind: "fleet", id: question.id)
  }

  private init(fleetTitle: String) {
    kind = "fleet"
    title = fleetTitle
    why = ""
    entityRef = nil
  }

  /// Chat about the supervisor as a whole: the daemon sends an overview.
  static let fleetOverview = BriefChatContext(fleetTitle: "Supervisor")
}
