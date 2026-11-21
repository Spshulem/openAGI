import Foundation

/// An image saved with a queued Supervisor send, so the send survives a quit
/// and still carries its screenshot when it finally goes.
struct SupervisorOutboxAttachment: Codable, Equatable, Sendable {
  let id: String
  let name: String
  let mimeType: String
  let data: String
  let thumbnail: String

  init(id: String, name: String, mimeType: String, data: String, thumbnail: String) {
    self.id = id
    self.name = name
    self.mimeType = mimeType
    self.data = data
    self.thumbnail = thumbnail
  }

  init(_ image: WorkspaceImageAttachment) {
    self.init(id: image.id, name: image.name, mimeType: image.mimeType, data: image.data, thumbnail: image.thumbnail)
  }

  var agentHostPayload: [String: Any] {
    ["id": id, "name": name, "mimeType": mimeType, "data": data, "thumbnail": thumbnail]
  }

  var thumbnailData: Data? { Data(base64Encoded: thumbnail) }
}

enum SupervisorOutboxState: String, Codable, Sendable {
  /// Never handed to main.
  case queued
  /// The POST is out and main hasn't said it has it. After a drop or a quit
  /// this is the ambiguous case: ask main before sending it again.
  case sending
  /// Main took it (a session frame or reply text). Only its reply is owed.
  case accepted
  /// Needs the owner: Retry (as a new message) or Remove.
  case failed
}

/// One Supervisor send the Mac still owes main. `id` is the turn's request id
/// for its whole life, so however often it goes out main runs it once.
struct SupervisorOutboxItem: Codable, Identifiable, Equatable, Sendable {
  var id: String
  var text: String
  var focusedCardId: String?
  var attachments: [SupervisorOutboxAttachment]
  let createdAt: Date
  var state: SupervisorOutboxState
  var failure: String?

  static func newRequestId() -> String {
    "mac-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
  }
}

/// Main's answer for one named turn (`GET /conversations/supervisor/turns`).
enum SupervisorTurnState: String, Decodable, Sendable {
  case queued, running, done, failed, interrupted, unknown
}

struct SupervisorTurnStatus: Decodable, Equatable, Sendable {
  let requestId: String
  let state: SupervisorTurnState
  let code: String?

  init(requestId: String, state: SupervisorTurnState, code: String? = nil) {
    self.requestId = requestId
    self.state = state
    self.code = code
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    requestId = try c.decode(String.self, forKey: .requestId)
    // A state this Mac doesn't know yet means "still on main": wait, never resend.
    state = SupervisorTurnState(rawValue: (try? c.decode(String.self, forKey: .state)) ?? "") ?? .running
    code = try? c.decodeIfPresent(String.self, forKey: .code)
  }

  private enum CodingKeys: String, CodingKey { case requestId, state, code }
}

enum SupervisorSendOutcome: Equatable, Sendable {
  /// The turn ended with a reply.
  case replied
  /// Main ran it and it failed, or refused it outright. Final either way.
  case failed(String)
}

enum SupervisorTransportError: Error, Equatable {
  /// The request never left this Mac (offline, main not listening): safe to
  /// send again as it is.
  case notSent(String)
  /// The connection dropped after the request went out. Main may have it.
  case lost(String)
}

/// How the outbox talks to main. The live client streams `/message`; tests
/// use a fake.
@MainActor
protocol SupervisorTurnTransport: AnyObject {
  func send(_ item: SupervisorOutboxItem, onAccepted: @escaping @MainActor () -> Void) async throws -> SupervisorSendOutcome
  /// nil when main has no turns route (an older main).
  func turnStates(ids: [String]) async throws -> [String: SupervisorTurnStatus]?
}

/// The outbox file. Every change is written before the network hears of it.
struct SupervisorOutboxStore {
  let url: URL?

  static var defaultURL: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return support.appendingPathComponent("OpenAGI/supervisor-outbox.json")
  }

  func load() -> [SupervisorOutboxItem] {
    guard let url, let data = try? Data(contentsOf: url) else { return [] }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return (try? decoder.decode([SupervisorOutboxItem].self, from: data)) ?? []
  }

  func save(_ items: [SupervisorOutboxItem]) throws {
    guard let url else { return }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(items).write(to: url, options: [.atomic])
  }
}

/// The Mac Supervisor's durable outbox. Sends go one at a time, in order; the
/// next goes only once main has finished the one before. After a drop, a
/// quit or main restarting, nothing is sent again until main has said how
/// each unconfirmed send stands, so a reconnect never releases a burst and
/// never runs one message twice.
@MainActor
final class SupervisorOutbox: ObservableObject {
  @Published private(set) var items: [SupervisorOutboxItem]
  /// The send whose stream is open right now.
  @Published private(set) var activeId: String?
  /// Why the outbox is holding (offline, waiting on a reply), for the tray.
  @Published private(set) var holdReason: String?

  weak var transport: SupervisorTurnTransport?
  /// Called after each send settles, so the transcript and tasks catch up.
  var onSettled: (() async -> Void)?

  private let store: SupervisorOutboxStore
  private let pollDelays: [Duration]
  private let retryDelays: [Duration]
  private var draining = false
  private var retryTask: Task<Void, Never>?
  private var retryAttempt = 0

  init(
    store: SupervisorOutboxStore,
    pollDelays: [Duration] = [.seconds(2), .seconds(3), .seconds(5), .seconds(10)],
    retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(10), .seconds(20), .seconds(30)]
  ) {
    self.store = store
    self.pollDelays = pollDelays
    self.retryDelays = retryDelays
    // A send that was going out when the Mac quit stays ambiguous: drain()
    // asks main about it before anything else goes.
    self.items = store.load()
  }

  var pending: Bool { items.contains { $0.state != .failed } }

  /// Saves the send before anything else happens, then starts the drain.
  @discardableResult
  func enqueue(text: String, focusedCardId: String? = nil, attachments: [SupervisorOutboxAttachment] = []) -> SupervisorOutboxItem {
    let item = SupervisorOutboxItem(
      id: SupervisorOutboxItem.newRequestId(),
      text: text,
      focusedCardId: focusedCardId,
      attachments: attachments,
      createdAt: Date(),
      state: .queued,
      failure: nil
    )
    items.append(item)
    persist()
    return item
  }

  /// Only a send main has never seen, or one that failed, can be taken back.
  @discardableResult
  func remove(id: String) -> SupervisorOutboxItem? {
    guard let index = items.firstIndex(where: { $0.id == id }),
          [.queued, .failed].contains(items[index].state), activeId != id else { return nil }
    let removed = items.remove(at: index)
    persist()
    return removed
  }

  /// The owner asked for a failed send again: a new turn with a new id, so it
  /// can never be mistaken for the one main already ran or refused.
  func retry(id: String) {
    guard let index = items.firstIndex(where: { $0.id == id }), items[index].state == .failed else { return }
    items[index].id = SupervisorOutboxItem.newRequestId()
    items[index].state = .queued
    items[index].failure = nil
    persist()
  }

  func drain() async {
    guard !draining, let transport else { return }
    draining = true
    defer { draining = false }
    retryTask?.cancel()
    retryTask = nil
    while let index = items.firstIndex(where: { $0.state != .failed }) {
      let item = items[index]
      switch item.state {
      case .queued:
        update(item.id) { $0.state = .sending }
        activeId = item.id
        holdReason = nil
        do {
          let outcome = try await transport.send(item) { [weak self] in
            self?.update(item.id) { $0.state = .accepted }
          }
          activeId = nil
          switch outcome {
          case .replied:
            drop(item.id)
          case .failed(let message):
            update(item.id) { $0.state = .failed; $0.failure = message }
          }
          retryAttempt = 0
          await onSettled?()
        } catch SupervisorTransportError.notSent(let message) {
          activeId = nil
          update(item.id) { if $0.state == .sending { $0.state = .queued } }
          hold("Not sent yet: \(message)")
          return
        } catch {
          // Main may have it: leave it unconfirmed and ask main next time.
          activeId = nil
          hold("Connection lost. Checking with OpenAGI before sending more.")
          return
        }
      case .sending, .accepted:
        guard await reconcile(item, transport: transport) else { return }
      case .failed:
        break
      }
    }
    holdReason = nil
    retryAttempt = 0
  }

  /// Settles one unconfirmed send with main's own record of it. Returns false
  /// when the drain has to stop (main unreachable).
  private func reconcile(_ item: SupervisorOutboxItem, transport: SupervisorTurnTransport) async -> Bool {
    var poll = 0
    while true {
      let answer: [String: SupervisorTurnStatus]?
      do {
        answer = try await transport.turnStates(ids: [item.id])
      } catch {
        hold("Can't reach OpenAGI. Will check again.")
        return false
      }
      guard let answer else {
        // An older main can't say whether it has this send. Never guess.
        update(item.id) {
          $0.state = .failed
          $0.failure = "OpenAGI couldn't confirm this message. Check the conversation before sending it again."
        }
        return true
      }
      switch answer[item.id]?.state ?? .running {
      case .done:
        drop(item.id)
        await onSettled?()
        return true
      case .failed:
        update(item.id) { $0.state = .failed; $0.failure = "OpenAGI couldn't complete this message." }
        await onSettled?()
        return true
      case .interrupted:
        update(item.id) { $0.state = .failed; $0.failure = "OpenAGI restarted while working on this. Retry to send it again." }
        return true
      case .unknown:
        // Main never took it: send it again under the same id.
        update(item.id) { $0.state = .queued }
        return true
      case .queued, .running:
        // Still on main: wait for it before anything behind it goes.
        update(item.id) { $0.state = .accepted }
        holdReason = "Waiting for OpenAGI to finish the previous message."
        let delay = pollDelays.isEmpty ? Duration.seconds(2) : pollDelays[min(poll, pollDelays.count - 1)]
        poll += 1
        try? await Task.sleep(for: delay)
        if Task.isCancelled { return false }
      }
    }
  }

  private func hold(_ reason: String) {
    holdReason = reason
    guard !retryDelays.isEmpty else { return }
    let delay = retryDelays[min(retryAttempt, retryDelays.count - 1)]
    retryAttempt += 1
    retryTask?.cancel()
    retryTask = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled else { return }
      await self?.drain()
    }
  }

  private func update(_ id: String, _ change: (inout SupervisorOutboxItem) -> Void) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
    change(&items[index])
    persist()
  }

  private func drop(_ id: String) {
    items.removeAll { $0.id == id }
    persist()
  }

  private func persist() {
    try? store.save(items)
  }
}

/// What the tray says for each outbox state.
struct SupervisorOutboxRowStatus: Equatable {
  let label: String
  let symbol: String

  init(_ state: SupervisorOutboxState) {
    switch state {
    case .queued:
      label = "Queued"
      symbol = "clock"
    case .sending:
      label = "Sent, not confirmed. Checking with OpenAGI"
      symbol = "arrow.up.circle"
    case .accepted:
      label = "Accepted. Waiting for the reply"
      symbol = "checkmark.circle"
    case .failed:
      label = "Failed"
      symbol = "exclamationmark.triangle"
    }
  }
}
