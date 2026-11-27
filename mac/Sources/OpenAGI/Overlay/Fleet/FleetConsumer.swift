import AppKit
import Foundation

/// The coding-agent supervisor's open questions, from the LOCAL daemon's
/// /fleet/api/* routes (the same JSON the /fleet page uses).
///
/// Fails soft: a daemon without a supervisor (404/503), or one that is off
/// with nothing open, just hides the Supervisor tab (never while the owner is
/// on it). Nothing here is optimistic — an answer can take minutes to reach
/// the agent (typing into an app), and the question stays on screen, in
/// flight, until the daemon says what happened.
@MainActor
final class FleetConsumer: ObservableObject {
  static let shared = FleetConsumer()

  @Published private(set) var questions: [FleetQuestion] = []
  @Published private(set) var openQuestionIDs: Set<String> = []
  /// The last scan's threads, for the Watching list under the questions.
  @Published private(set) var threads: [FleetThread] = []
  /// The hub's decision brief for each open question, by question id.
  @Published private(set) var cardBriefs: [String: FleetCardBrief] = [:]
  @Published private(set) var activityEvents: [FleetActivityEvent] = []
  @Published private(set) var nextTickAt: String? = nil
  /// Watching groups the owner opened that start collapsed (Quiet).
  @Published private(set) var openWatchGroups: Set<String> = []
  @Published private(set) var status: FleetStatus? = nil
  /// False hides the Supervisor tab.
  @Published private(set) var available = false
  @Published private(set) var isLoading = false
  @Published private(set) var scanning = false
  /// Question ids with an answer or dismissal in flight.
  @Published private(set) var inFlight: Set<String> = []
  /// Answers that timed out here while the daemon may still be delivering
  /// them. Their buttons stay off until the question closes or the wait ends:
  /// a second tap would only hit the daemon's in-progress guard.
  @Published private(set) var stillSending: Set<String> = []
  /// Each open question's last result, shown in its own row, so two answers
  /// in flight can never be mixed up.
  @Published private(set) var notes: [String: FleetNote] = [:]
  /// Scan, refresh, and closed-question results.
  @Published private(set) var lastOutcome: String? = nil
  @Published private(set) var lastError: String? = nil
  /// The question or thread on the detail screen; nil shows the lists.
  /// Changes the panel's height.
  @Published private(set) var openItem: FleetOpenItem? = nil
  /// Typed replies not sent yet, by FleetOpenItem.key. Kept across Back and
  /// a failed send; cleared once the hub takes it.
  @Published private(set) var drafts: [String: String] = [:]
  /// Optional image payloads attached to a workspace reply, keyed by FleetOpenItem.key.
  @Published var pendingReplyImages: [String: [[String: Any]]] = [:]
  /// FleetOpenItem keys with a reply in flight.
  @Published private(set) var replyInFlight: Set<String> = []
  /// Each item's last reply result, under its reply box.
  @Published private(set) var replyNotes: [String: FleetNote] = [:]
  /// GET /fleet/api/threads/:key, by thread key, for opened rows and cards.
  @Published private(set) var details: [String: FleetThreadDetail] = [:]
  @Published private(set) var detailLoading: Set<String> = []
  /// Thread keys with a Push now, Mute or Unmute in flight.
  @Published private(set) var threadInFlight: Set<String> = []
  /// Each thread's last Push now, Mute or Unmute result, in its row.
  @Published private(set) var threadNotes: [String: FleetNote] = [:]
  @Published private(set) var workspaces: [FleetWorkspaceEntry] = []
  @Published private(set) var hierarchyProjects: [FleetHierarchyProject] = []
  /// Active index in the compact overlay single-card deck.
  @Published var currentQuestionIndex: Int = 0
  /// Whether the collapsible session list in the overlay is expanded.
  @Published var watchingExpanded: Bool = false
  /// An ask with several questions: the owner's unsent answers and skips,
  /// by question id, then item id. Mirrored to UserDefaults so a walkthrough
  /// resumes after a relaunch.
  @Published private(set) var itemDrafts: [String: [String: FleetQuestionItemDraft]] = [:]
  /// Open question walkthroughs: question id -> the item index on screen.
  /// Changes the panel's height.
  @Published private(set) var walkthroughs: [String: Int] = [:]
  /// Question ids with an answer_items request in flight.
  @Published private(set) var itemsInFlight: Set<String> = []
  /// Each several-question ask's last send result.
  @Published private(set) var itemNotes: [String: FleetNote] = [:]

  /// Bumped by every refresh start and every apply. A refresh publishes only
  /// if nothing newer started or landed meanwhile, so a slow GET can never
  /// overwrite the state an answer or a scan just returned.
  private var generation: UInt64 = 0
  /// Depth counter, not a Bool: overlapping refreshes each own one decrement.
  private var loadingDepth = 0
  /// True when `lastError` came from a refresh, so the next good refresh may
  /// clear it. An answer's error stays until Dismiss or the next action.
  private var refreshOwnsError = false
  /// What the last state said: a supervisor that is on, or has questions.
  /// `available` can stay true past this while the owner is on the tab.
  private var hasSupervisor = false
  /// When each `stillSending` wait ends.
  private var sendingDeadline: [String: Date] = [:]
  /// One follow-up refresh while a tick runs: a tick that throws never emits
  /// its "fleet" event, and `running` must not stick.
  private var runningRecheck: Task<Void, Never>?
  private static let stillSendingWait: TimeInterval = 300
  /// The scan the opened row's detail was last read for.
  private var lastDetailTick: String?
  private var pendingDetails: Set<String> = []
  private let fetchDetail: (URLRequest) async throws -> (Data, URLResponse)
  /// Replies' POSTs; tests stand in for the hub.
  private let send: (URLRequest) async throws -> (Data, URLResponse)
  private let itemDraftStore: FleetQuestionItemDraftStore

  init(fetchDetail: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) },
       send: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) },
       itemDraftDefaults: UserDefaults = .standard) {
    self.fetchDetail = fetchDetail
    self.send = send
    self.itemDraftStore = FleetQuestionItemDraftStore(defaults: itemDraftDefaults)
  }

  func refresh() async {
    generation &+= 1
    let mine = generation
    loadingDepth += 1
    isLoading = true
    defer {
      loadingDepth = max(0, loadingDepth - 1)
      isLoading = loadingDepth > 0
    }
    let req = request(path: "/fleet/api/state", method: "GET", timeout: 6)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      guard mine == generation else { return }
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        guard let state = try? JSONDecoder().decode(FleetState.self, from: data) else {
          refreshFailed()
          return
        }
        apply(state)
        setRefreshError(nil)
      case 404, 503:
        // No supervisor on this daemon (or a daemon too old to have one).
        clearState()
        setRefreshError(nil)
      case 401:
        setRefreshError("Daemon sign-in failed.")
      default:
        refreshFailed()
      }
    } catch {
      guard mine == generation else { return }
      refreshFailed()
    }
  }

  func answer(_ question: FleetQuestion, option: String) async {
    // An ask with several questions is answered question by question: a
    // reply to the whole group is never sent (the hub refuses it too).
    if cardBriefs[question.id]?.hasQuestionItems == true, FleetQuestionItemsLogic.isGroupAnswer(option) {
      notes[question.id] = FleetNote(text: "Answer each question on its own; a blanket answer is not sent.", isError: true)
      return
    }
    await decide(question, body: ["answer": option], dismissed: false)
  }

  func dismiss(_ question: FleetQuestion) async {
    await decide(question, body: ["dismiss": true], dismissed: true)
  }

  private func decide(_ question: FleetQuestion, body: [String: Any], dismissed: Bool) async {
    let id = question.id
    guard !inFlight.contains(id), !stillSending.contains(id) else { return }
    inFlight.insert(id)
    defer { inFlight.remove(id) }
    notes[id] = nil

    var req = request(path: "/fleet/api/questions/\(id)", method: "POST", timeout: 150)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        let decoded = try? JSONDecoder().decode(FleetQuestionResponse.self, from: data)
        if let state = decoded?.state { apply(state) } else { await refresh() }
        let result = Self.outcome(decoded, dismissed: dismissed)
        report(question, result.text, isError: result.isError)
      case 409:
        // The daemon is still inside an earlier answer to this question
        // (its in-progress guard), or another surface closed it.
        await refresh()
        if isOpen(id) {
          report(question, "The last answer is still being sent. Check back in a minute.", isError: false)
        } else {
          report(question, Self.serverError(data) ?? "Question already closed.", isError: true)
        }
      case 400, 404, 500:
        await refresh()
        report(question, Self.serverError(data) ?? "The supervisor couldn't take that answer.", isError: true)
      case 503:
        report(question, "Supervisor isn't available.", isError: true)
      case 401:
        report(question, "Daemon sign-in failed.", isError: true)
      default:
        report(question, "Couldn't reach the supervisor. Try again.", isError: true)
      }
    } catch let error as URLError where error.code == .timedOut {
      markStillSending(id)
      report(question, "No reply yet. It may still be sending.", isError: false)
      await refresh()
    } catch {
      report(question, "Couldn't reach the supervisor. Try again.", isError: true)
    }
  }

  /// In the question's row while it is open; once it has closed, the
  /// panel-wide line, named, since the row is gone.
  private func report(_ question: FleetQuestion, _ text: String, isError: Bool) {
    if isOpen(question.id) {
      notes[question.id] = FleetNote(text: text, isError: isError)
    } else if isError {
      setActionError("\(Self.named(question)): \(text)")
    } else {
      lastOutcome = "\(Self.named(question)): \(text)"
    }
  }

  private func isOpen(_ id: String) -> Bool { questions.contains { $0.id == id } }

  private func markStillSending(_ id: String) {
    stillSending.insert(id)
    let deadline = Date().addingTimeInterval(Self.stillSendingWait)
    sendingDeadline[id] = deadline
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(FleetConsumer.stillSendingWait * 1_000_000_000))
      guard let self, let current = self.sendingDeadline[id], current <= Date() else { return }
      self.sendingDeadline[id] = nil
      self.stillSending.remove(id)
      await self.refresh()
    }
  }

  // MARK: - Detail screen

  /// Opens an In progress thread's detail screen and loads its chat.
  func openThread(_ key: String) {
    openItem = .thread(key)
    if let thread = thread(key) { OverlayState.shared.selectVoiceContext(.thread(thread)) }
    Task { await loadDetail(key) }
  }

  /// Opens a Needs you question's detail screen and loads its thread's chat.
  func openQuestion(_ question: FleetQuestion) {
    openItem = .question(question.id)
    OverlayState.shared.selectVoiceContext(.question(question))
    if let key = question.threadKey { Task { await loadDetail(key) } }
  }

  /// Back to the lists. The voice focus stays only if it was on something
  /// else.
  func closeItem() {
    guard let item = openItem else { return }
    openItem = nil
    let focus = OverlayState.shared.voiceFocus
    switch item {
    case let .question(id):
      if focus.questionId == id { OverlayState.shared.selectVoiceContext(VoiceFocus()) }
    case let .thread(key):
      if focus.threadKey == key, focus.questionId == nil { OverlayState.shared.selectVoiceContext(VoiceFocus()) }
    }
  }

  func question(_ id: String) -> FleetQuestion? { questions.first { $0.id == id } }

  /// Where the open item's typed reply goes.
  func replyTarget(_ item: FleetOpenItem) -> FleetReplyTarget {
    switch item {
    case let .question(id):
      return question(id).map { FleetReplyTarget.of($0) } ?? .none(why: "The question has closed.")
    case let .thread(key):
      return .of(threadKey: key)
    }
  }

  func setDraft(_ text: String, for item: FleetOpenItem) {
    drafts[item.key] = text.isEmpty ? nil : text
  }

  /// Routes workspace thread/question replies through the single `sendReply`
  /// path (preserving Quick Ask / Supervisor Workspace image & text invariants).
  func sendWorkspaceThreadReply(threadKey: String, message: String, images: [[String: Any]] = []) async -> FleetNote {
    await sendWorkspaceReply(for: .thread(threadKey), message: message, images: images)
  }

  /// Reply to a Needs-You card with optional photo attachments via `sendReply`.
  func sendWorkspaceQuestionReply(_ question: FleetQuestion, message: String, images: [[String: Any]] = []) async -> FleetNote {
    if question.isClarificationQuestion {
      return await answerClarification(question, clarification: message)
    }
    return await sendWorkspaceReply(for: .question(question.id), message: message, images: images)
  }

  /// Answers a `suggestion` clarification card via `/fleet/api/questions/:id` with `{ answer: "Answer question", clarification }`.
  func answerClarification(_ question: FleetQuestion, clarification: String) async -> FleetNote {
    let trimmed = String(clarification.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
    guard !trimmed.isEmpty else {
      return FleetNote(text: "Enter an answer first.", isError: true)
    }
    let id = question.id
    guard !inFlight.contains(id) else {
      return FleetNote(text: "Already sending an answer for this question.", isError: false)
    }
    inFlight.insert(id)
    defer { inFlight.remove(id) }
    notes[id] = nil

    var req = request(path: "/fleet/api/questions/\(id)", method: "POST", timeout: 150)
    req.httpBody = try? JSONSerialization.data(withJSONObject: [
      "answer": "Answer question",
      "clarification": trimmed
    ])
    do {
      let (data, response) = try await send(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(code) {
        if let decoded = try? JSONDecoder().decode(FleetQuestionResponse.self, from: data),
           let state = decoded.state {
          apply(state)
        } else {
          await refresh()
        }
        let note = FleetNote(text: "Clarification saved to plan.", isError: false)
        report(question, note.text, isError: false)
        return note
      }
      await refresh()
      let msg = Self.serverError(data) ?? "Couldn't save clarification."
      let note = FleetNote(text: msg, isError: true)
      report(question, msg, isError: true)
      return note
    } catch {
      let msg = "Couldn't reach the supervisor. Try again."
      report(question, msg, isError: true)
      return FleetNote(text: msg, isError: true)
    }
  }

  func loadWorkspaces() async {
    let req = request(path: "/fleet/api/workspaces?limit=40", method: "GET", timeout: 15)
    do {
      let (data, response) = try await fetchDetail(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(code) else { return }
      struct WorkspacesResp: Decodable { let workspaces: [FleetWorkspaceEntry]? }
      if let decoded = try? JSONDecoder().decode(WorkspacesResp.self, from: data),
         let list = decoded.workspaces {
        workspaces = list
      }
    } catch {
      // Non-fatal: manual workspace or auto-resolve still works.
    }
  }

  func loadHierarchy(limit: Int = 60) async {
    let clamped = max(1, min(60, limit))
    let req = request(path: "/fleet/api/hierarchy?limit=\(clamped)", method: "GET", timeout: 20)
    do {
      let (data, response) = try await fetchDetail(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(code) else { return }
      if let decoded = try? JSONDecoder().decode(FleetHierarchyResponse.self, from: data) {
        hierarchyProjects = decoded.projects
      }
    } catch {
      // Non-fatal: sidebar degrades cleanly to live watched threads.
    }
  }

  @discardableResult
  func upsertProject(name: String, theme: String? = nil, alias: String? = nil) async -> Bool {
    let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleanName.isEmpty else { return false }
    var payload: [String: Any] = ["name": cleanName]
    if let cleanTheme = theme?.trimmingCharacters(in: .whitespacesAndNewlines), !cleanTheme.isEmpty {
      payload["theme"] = cleanTheme
    }
    if let cleanAlias = alias?.trimmingCharacters(in: .whitespacesAndNewlines), !cleanAlias.isEmpty {
      payload["alias"] = cleanAlias
    }
    var req = request(path: "/fleet/api/projects", method: "POST", timeout: 15)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    do {
      let (_, response) = try await send(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(code) else { return false }
      await loadHierarchy()
      await refresh()
      return true
    } catch {
      return false
    }
  }

  @discardableResult
  func organizeThread(key: String, project: String?, theme: String? = nil) async -> Bool {
    guard let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return false }
    var payload: [String: Any] = [:]
    if let p = project?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty {
      payload["project"] = p
    }
    if let t = theme?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
      payload["theme"] = t
    }
    var req = request(path: "/fleet/api/threads/\(encoded)/organize", method: "POST", timeout: 15)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    do {
      let (_, response) = try await send(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(code) else { return false }
      await loadHierarchy()
      await refresh()
      return true
    } catch {
      return false
    }
  }

  func startWorkspaceSession(
    workspace: String?,
    cwd: String?,
    serverId: String? = nil,
    title: String?,
    model: String?,
    effort: String?,
    prompt: String,
    images: [[String: Any]] = []
  ) async -> (ok: Bool, threadKey: String?, message: String) {
    let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    let effectivePrompt = trimmedPrompt.isEmpty && !images.isEmpty ? "Please inspect the attached image(s)." : trimmedPrompt
    guard !effectivePrompt.isEmpty else {
      return (false, nil, "Enter a starting prompt first.")
    }
    var payload: [String: Any] = ["prompt": effectivePrompt]
    if let ws = workspace?.trimmingCharacters(in: .whitespacesAndNewlines), !ws.isEmpty {
      payload["workspace"] = ws
    }
    if let c = cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty {
      payload["cwd"] = c
    }
    if let srv = serverId?.trimmingCharacters(in: .whitespacesAndNewlines), !srv.isEmpty {
      payload["serverId"] = srv
    }
    if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
      payload["title"] = t
    }
    if let m = model?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty {
      payload["model"] = m
    }
    if let e = effort?.trimmingCharacters(in: .whitespacesAndNewlines), !e.isEmpty {
      payload["effort"] = e
    }
    if !images.isEmpty {
      payload["images"] = images
    }
    var req = request(path: "/fleet/api/sessions/start", method: "POST", timeout: 150)
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    do {
      let (data, response) = try await send(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(code) else {
        return (false, nil, Self.serverError(data) ?? "Couldn't start Paseo session.")
      }
      struct SessionObj: Decodable { let threadKey: String? }
      struct StartResp: Decodable { let session: SessionObj?; let state: FleetState? }
      let decoded = try? JSONDecoder().decode(StartResp.self, from: data)
      if let state = decoded?.state {
        apply(state)
      } else {
        await refresh()
      }
      if let tk = decoded?.session?.threadKey {
        await loadDetail(tk)
      }
      return (true, decoded?.session?.threadKey, "Started Paseo session.")
    } catch {
      return (false, nil, "Couldn't reach the supervisor. Try again.")
    }
  }

  private func sendWorkspaceReply(for item: FleetOpenItem, message: String, images: [[String: Any]]) async -> FleetNote {
    let targetItem: FleetOpenItem
    if case let .question(id) = item, !images.isEmpty, let tk = question(id)?.threadKey {
      targetItem = .thread(tk)
    } else {
      targetItem = item
    }
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    let effective = trimmed.isEmpty && !images.isEmpty ? "Please inspect the attached image(s)." : trimmed
    guard FleetReplyTarget.message(effective) != nil else {
      return FleetNote(text: "Enter a message or attach a photo first.", isError: true)
    }
    let slot = targetItem.key
    drafts[slot] = effective
    pendingReplyImages[slot] = images.isEmpty ? nil : images
    await sendReply(targetItem)
    if let note = replyNotes[slot] { return note }
    if !replyInFlight.contains(slot), drafts[slot] == nil {
      return FleetNote(text: "Sent to the agent.", isError: false)
    }
    return FleetNote(text: "Couldn't send reply.", isError: true)
  }

  func clearReplyNote(_ item: FleetOpenItem) {
    replyNotes[item.key] = nil
  }

  /// Sends the item's draft. The draft stays until the hub takes it (sent
  /// or queued): a refusal, an older hub's 400, or no answer keeps it.
  func sendReply(_ item: FleetOpenItem) async {
    let slot = item.key
    guard !replyInFlight.contains(slot), let submitted = drafts[slot], let message = FleetReplyTarget.message(submitted) else { return }
    let attachedImages = pendingReplyImages[slot] ?? []
    var target = replyTarget(item)
    if case let .question(id) = item, !attachedImages.isEmpty {
      if let tk = question(id)?.threadKey {
        target = .thread(key: tk)
      } else {
        replyNotes[slot] = FleetNote(text: "This question isn't linked to a coding thread for image attachments.", isError: true)
        return
      }
    }
    let path: String
    var body: [String: Any]
    switch target {
    case let .question(id):
      if let q = question(id), q.isClarificationQuestion {
        path = "/fleet/api/questions/\(id)"
        body = ["answer": "Answer question", "clarification": message]
      } else {
        path = "/fleet/api/questions/\(id)"
        body = ["reply": message]
      }
    case let .thread(key):
      path = "/fleet/api/send"
      body = ["threadKey": key, "message": message]
      if !attachedImages.isEmpty { body["images"] = attachedImages }
    case let .none(why):
      replyNotes[slot] = FleetNote(text: why, isError: true)
      return
    }
    // The question's own thread, before the send: a late result or an
    // unsent draft goes there and nowhere else.
    var fallbackKey: String? = nil
    if case let .question(id) = item { fallbackKey = question(id)?.threadKey }
    replyInFlight.insert(slot)
    defer { replyInFlight.remove(slot) }
    replyNotes[slot] = nil
    var req = request(path: path, method: "POST", timeout: 150)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (data, response) = try await send(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      let note = Self.replyNote(code: code, data: data, target: target)
      if note.taken {
        drafts[slot] = Self.unsentRest(drafts[slot], submitted: submitted)
        pendingReplyImages[slot] = nil
      }
      replyNotes[slot] = note.note
      if (200..<300).contains(code) {
        if let state = (try? JSONDecoder().decode(FleetQuestionResponse.self, from: data))?.state {
          apply(state)
        } else {
          await refresh()
        }
        // The thread left the scan with the screen on it: the panel-wide
        // line says what happened, since the screen is gone.
        if case .thread = target, openItem == nil {
          if note.note.isError { setActionError(note.note.text) } else { lastOutcome = note.note.text }
        }
      }
    } catch let error as URLError where error.code == .timedOut {
      replyNotes[slot] = FleetNote(text: "No reply yet. It may still be sending; check the chat before sending again.", isError: false)
      await refresh()
    } catch {
      replyNotes[slot] = FleetNote(text: "Couldn't reach the supervisor. Try again.", isError: true)
    }
    // The chat moved on (or should have): read it again.
    if case let .thread(key) = target { await loadDetail(key) }
    if case .question = target, let key = replyThreadKey(item) { await loadDetail(key) }
    // The question closed (this reply, or a refresh during it): its result
    // and any unsent draft move to its own thread, else the panel-wide line.
    if case let .question(id) = item, question(id) == nil {
      let leftNote = replyNotes[slot]
      let leftDraft = drafts[slot]
      replyNotes[slot] = nil
      drafts[slot] = nil
      if let key = fallbackKey, thread(key) != nil {
        let to = FleetOpenItem.thread(key).key
        if let leftNote { replyNotes[to] = leftNote }
        if let leftDraft { drafts[to] = Self.joinDrafts(drafts[to], leftDraft) }
      } else if let leftNote {
        if leftNote.isError { setActionError(leftNote.text) } else { lastOutcome = leftNote.text }
      }
    }
  }

  private func replyThreadKey(_ item: FleetOpenItem) -> String? {
    switch openItem ?? item {
    case let .thread(key): return key
    case let .question(id): return question(id)?.threadKey
    }
  }

  /// After a send is taken: what is left in the box that was not sent (a
  /// closed question's draft joined on meanwhile), or nil.
  static func unsentRest(_ current: String?, submitted: String) -> String? {
    guard let current, current != submitted else { return nil }
    let rest = current.hasPrefix(submitted) ? String(current.dropFirst(submitted.count)) : current
    let trimmed = rest.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// Two unsent drafts in one box: neither is lost.
  static func joinDrafts(_ existing: String?, _ moved: String) -> String {
    guard let existing, !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, existing != moved else { return moved }
    return existing + "\n\n" + moved
  }

  /// What a reply's answer means: the note under the box, and whether the
  /// hub took the words (so the draft can go). Pure, unit-tested.
  static func replyNote(code: Int, data: Data, target: FleetReplyTarget) -> (note: FleetNote, taken: Bool) {
    switch code {
    case 200..<300:
      let decoded = try? JSONDecoder().decode(FleetQuestionResponse.self, from: data)
      let note = FleetThreadOutcome.reply(decoded?.delivery)
      return (note, !note.isError)
    case 400:
      // An older hub refuses { reply } with "Pick one of the question's options."
      return (FleetNote(text: serverError(data) ?? "The supervisor couldn't take that reply.", isError: true), false)
    case 404:
      if case .question = target {
        return (FleetNote(text: serverError(data) ?? "The question has closed.", isError: true), false)
      }
      return (FleetNote(text: serverError(data) ?? "This hub can't send replies yet.", isError: true), false)
    case 409:
      return (FleetNote(text: serverError(data) ?? "The question already closed.", isError: true), false)
    case 401:
      return (FleetNote(text: "Daemon sign-in failed.", isError: true), false)
    case 503:
      return (FleetNote(text: serverError(data) ?? "Supervisor isn't available.", isError: true), false)
    default:
      return (FleetNote(text: serverError(data) ?? "Couldn't reach the supervisor. Try again.", isError: true), false)
    }
  }

  /// The thread whose chat the detail screen shows.
  var openThreadKey: String? {
    switch openItem {
    case let .thread(key): return key
    case let .question(id): return question(id)?.threadKey
    case nil: return nil
    }
  }

  /// The open questions about one thread, grouped ones included.
  func questions(about key: String) -> [FleetQuestion] {
    questions.filter { $0.threadKey == key || $0.threadKeys.contains(key) || $0.chats.contains { $0.threadKey == key } }
  }

  func thread(_ key: String) -> FleetThread? { threads.first { $0.key == key } }

  /// A failed read keeps what the row already shows from the scan.
  func loadDetail(_ key: String) async {
    guard !detailLoading.contains(key) else {
      pendingDetails.insert(key)
      return
    }
    detailLoading.insert(key)
    defer { detailLoading.remove(key) }
    repeat {
      pendingDetails.remove(key)
      await readDetail(key)
    } while pendingDetails.contains(key)
  }

  private func readDetail(_ key: String) async {
    let req = request(path: Self.threadPath(key), method: "GET", timeout: 8)
    guard let (data, response) = try? await fetchDetail(req) else { return }
    switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
    case 200..<300:
      if let detail = FleetThreadDetail.decodeResponse(data) { details[key] = detail }
    case 404:
      // Not in the last scan any more.
      details[key] = nil
    default:
      return
    }
  }

  /// Push now: the thread's planned nudge goes out at once, as the owner's
  /// own message. The daemon still refuses one that waits on an answer.
  func pushNow(_ key: String) async {
    await threadAction(key, "push", body: [:])
  }

  func mute(_ key: String, hours: Int = 24) async {
    await threadAction(key, "mute", body: ["hours": hours])
  }

  func unmute(_ key: String) async {
    await threadAction(key, "unmute", body: [:])
  }

  private func threadAction(_ key: String, _ action: String, body: [String: Any]) async {
    guard !threadInFlight.contains(key) else { return }
    threadInFlight.insert(key)
    defer { threadInFlight.remove(key) }
    threadNotes[key] = nil
    // A push types into the agent's app, which can take minutes.
    var req = request(path: Self.threadPath(key) + "/" + action, method: "POST", timeout: action == "push" ? 150 : 15)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
      case 200..<300:
        let decoded = try? JSONDecoder().decode(FleetThreadActionResponse.self, from: data)
        threadNotes[key] = action == "push" ? FleetThreadOutcome.push(decoded?.delivery) : FleetThreadOutcome.muted(decoded?.muted)
        if let state = decoded?.state { apply(state) } else { await refresh() }
        if openItem == .thread(key) { await loadDetail(key) }
      case 503:
        threadNotes[key] = FleetNote(text: Self.serverError(data) ?? "Supervisor isn't available.", isError: true)
      case 401:
        threadNotes[key] = FleetNote(text: "Daemon sign-in failed.", isError: true)
      default:
        // 400 (bad key or hours), 404 (a daemon without these routes).
        threadNotes[key] = FleetNote(text: Self.serverError(data) ?? "The supervisor couldn't do that.", isError: true)
      }
    } catch let error as URLError where error.code == .timedOut {
      threadNotes[key] = FleetNote(text: "No reply yet. It may still be sending.", isError: false)
      await refresh()
    } catch {
      threadNotes[key] = FleetNote(text: "Couldn't reach the supervisor. Try again.", isError: true)
    }
  }

  func clearThreadNote(_ key: String) {
    threadNotes[key] = nil
  }

  /// Lands in that exact chat when it has a link; else brings its app to
  /// the front, where its workspace is named on the row.
  func openChat(_ chat: FleetOpenChat) {
    switch FleetChatOpener.target(chat) {
    case let .link(url):
      if !NSWorkspace.shared.open(url) { setActionError("Couldn't open \(chat.label).") }
    case let .app(bundleIdentifier, name):
      guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else {
        setActionError("\(name) isn't installed on this Mac.")
        return
      }
      NSWorkspace.shared.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
    case .nowhere:
      break
    }
  }

  /// "conductor:abc" -> "/fleet/api/threads/conductor%3Aabc".
  static func threadPath(_ key: String) -> String {
    "/fleet/api/threads/" + key.replacingOccurrences(of: ":", with: "%3A")
  }

  /// Opens or closes a Watching group that starts collapsed.
  func toggleWatchGroup(_ group: String) {
    if openWatchGroups.contains(group) { openWatchGroups.remove(group) } else { openWatchGroups.insert(group) }
  }

  func stepQuestion(_ delta: Int) {
    guard !questions.isEmpty else {
      currentQuestionIndex = 0
      return
    }
    currentQuestionIndex = (currentQuestionIndex + delta % questions.count + questions.count) % questions.count
  }

  func toggleWatchingExpanded() {
    watchingExpanded.toggle()
  }

  func clearNote(_ id: String) {
    notes[id] = nil
  }

  /// "Scan now": a full supervisor tick, which rechecks every open question.
  func scan() async {
    guard !scanning else { return }
    scanning = true
    defer { scanning = false }
    clearOutcome()

    var req = request(path: "/fleet/api/scan", method: "POST", timeout: 330)
    req.httpBody = Data("{}".utf8)
    do {
      let (data, response) = try await URLSession.shared.data(for: req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        if let state = try? JSONDecoder().decode(FleetState.self, from: data) {
          apply(state)
        } else {
          await refresh()
        }
      case 500:
        let state = (try? JSONDecoder().decode(FleetErrorBody.self, from: data))?.state
        if let state { apply(state) }
        // The status line already says "Last scan failed: …"; one red row is enough.
        if (state?.lastError ?? "").isEmpty { setActionError("Scan failed.") }
      case 404, 503:
        setActionError("Supervisor isn't available.")
      case 401:
        setActionError("Daemon sign-in failed.")
      default:
        setActionError(Self.serverError(data) ?? "Scan failed.")
      }
    } catch let error as URLError where error.code == .timedOut {
      setActionError("The scan is still running. Check back soon.")
      await refresh()
    } catch {
      setActionError("Couldn't reach the supervisor. Try again.")
    }
  }

  func clearOutcome() {
    lastOutcome = nil
    lastError = nil
    refreshOwnsError = false
  }

  // MARK: - Several questions in one ask

  /// The card when this question is an open ask with two or more questions,
  /// answered one by one. Nil for a single question (the #391 decision
  /// contract), an update, or a completed acknowledgment.
  func questionItemsCard(for question: FleetQuestion) -> FleetCardBrief? {
    guard question.needsYou, let card = cardBriefs[question.id], card.asksQuestionItems else { return nil }
    return card
  }

  func itemDraft(_ questionId: String, _ itemId: String) -> FleetQuestionItemDraft? {
    itemDrafts[questionId]?[itemId]
  }

  /// The owner picked a choice or typed: the draft for that question. A
  /// blank answer clears it. Nothing is sent.
  func setItemAnswer(_ answer: String?, questionId: String, itemId: String) {
    var drafts = itemDrafts[questionId] ?? [:]
    let text = answer ?? ""
    drafts[itemId] = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : FleetQuestionItemDraft(answer: text, skipped: false)
    storeItemDrafts(drafts, for: questionId)
  }

  /// Skip for now: sent with the next Send so the agent knows it stays open.
  func skipItem(questionId: String, itemId: String) {
    var drafts = itemDrafts[questionId] ?? [:]
    drafts[itemId] = FleetQuestionItemDraft(answer: nil, skipped: true)
    storeItemDrafts(drafts, for: questionId)
  }

  func clearItemDraft(questionId: String, itemId: String) {
    var drafts = itemDrafts[questionId] ?? [:]
    drafts[itemId] = nil
    storeItemDrafts(drafts, for: questionId)
  }

  /// "Review N questions": opens the walkthrough where the owner left off.
  /// Sends nothing.
  func startWalkthrough(_ question: FleetQuestion) {
    guard let card = questionItemsCard(for: question) else { return }
    let saved = itemDraftStore.load(question.id).position
    walkthroughs[question.id] = FleetQuestionItemsLogic.startIndex(items: card.questionItems, drafts: itemDrafts[question.id] ?? [:], saved: saved)
  }

  func closeWalkthrough(_ questionId: String) {
    walkthroughs[questionId] = nil
  }

  /// Back / Next / a jump from the list. The position is saved to resume.
  func moveWalkthrough(_ questionId: String, to index: Int) {
    guard let count = cardBriefs[questionId]?.questionItems.count, count > 0 else { return }
    let clamped = min(max(index, 0), count - 1)
    walkthroughs[questionId] = clamped
    var saved = itemDraftStore.load(questionId)
    saved.drafts = itemDrafts[questionId] ?? [:]
    saved.position = clamped
    itemDraftStore.save(saved, for: questionId)
  }

  func clearItemNote(_ questionId: String) { itemNotes[questionId] = nil }

  /// The request Send would make now.
  func pendingItemsRequest(for question: FleetQuestion, only: Set<String>? = nil) -> FleetAnswerItemsRequest {
    guard let card = cardBriefs[question.id], card.hasQuestionItems else { return FleetAnswerItemsRequest() }
    return FleetQuestionItemsLogic.request(items: card.questionItems, drafts: itemDrafts[question.id] ?? [:], only: only)
  }

  /// POST /fleet/api/cards/:id/act { op: "answer_items", items, skip }: the
  /// drafted answers and skips in one request (`only` = Retry of one). The
  /// result shows per question from the hub's own item states.
  func sendItemAnswers(_ question: FleetQuestion, only: Set<String>? = nil) async {
    let qid = question.id
    guard let card = cardBriefs[qid], card.hasQuestionItems, !itemsInFlight.contains(qid) else { return }
    let payload = FleetQuestionItemsLogic.request(items: card.questionItems, drafts: itemDrafts[qid] ?? [:], only: only)
    guard !payload.isEmpty else {
      itemNotes[qid] = FleetNote(text: "Answer or skip at least one question first.", isError: true)
      return
    }
    itemsInFlight.insert(qid)
    defer { itemsInFlight.remove(qid) }
    itemNotes[qid] = nil

    var req = request(path: Self.cardActPath(card.id), method: "POST", timeout: 150)
    req.httpBody = try? JSONSerialization.data(withJSONObject: payload.body)
    do {
      let (data, response) = try await send(req)
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200..<300:
        let decoded = try? JSONDecoder().decode(FleetCardActResponse.self, from: data)
        if let state = decoded?.state { apply(state) } else { await refresh() }
        let resultItems = decoded?.result?.items ?? []
        let items = resultItems.isEmpty ? (cardBriefs[qid]?.questionItems ?? []) : resultItems
        if isOpen(qid) {
          storeItemDrafts(FleetQuestionItemsLogic.draftsAfterSend(itemDrafts[qid] ?? [:], sent: payload, items: items), for: qid)
          itemNotes[qid] = FleetQuestionItemsLogic.outcome(decoded?.result)
        } else {
          lastOutcome = "\(Self.named(question)): every question answered."
        }
      case 404:
        await refresh()
        if isOpen(qid) {
          itemNotes[qid] = FleetNote(text: Self.serverError(data) ?? "The supervisor couldn't find this card. Your answers are kept.", isError: true)
        } else {
          setActionError("\(Self.named(question)): question already closed.")
        }
      case 400, 409, 500:
        await refresh()
        itemNotes[qid] = FleetNote(text: (Self.serverError(data) ?? "The supervisor couldn't take those answers.") + " Your answers are kept.", isError: true)
      case 503:
        itemNotes[qid] = FleetNote(text: "Supervisor isn't available. Your answers are kept.", isError: true)
      case 401:
        itemNotes[qid] = FleetNote(text: "Daemon sign-in failed. Your answers are kept.", isError: true)
      default:
        itemNotes[qid] = FleetNote(text: "Couldn't reach the supervisor. Your answers are kept.", isError: true)
      }
    } catch let error as URLError where error.code == .timedOut {
      itemNotes[qid] = FleetNote(text: "No reply yet. The answers may still be sending; check each question's state before sending again.", isError: false)
      await refresh()
    } catch {
      itemNotes[qid] = FleetNote(text: "Couldn't reach the supervisor. Your answers are kept.", isError: true)
    }
  }

  /// "/fleet/api/cards/<id>/act", the id percent-encoded.
  static func cardActPath(_ cardId: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.")
    return "/fleet/api/cards/\(cardId.addingPercentEncoding(withAllowedCharacters: allowed) ?? cardId)/act"
  }

  private func storeItemDrafts(_ drafts: [String: FleetQuestionItemDraft], for questionId: String) {
    let kept = drafts.filter { !$0.value.isEmpty }
    itemDrafts[questionId] = kept.isEmpty ? nil : kept
    var saved = itemDraftStore.load(questionId)
    saved.drafts = kept
    itemDraftStore.save(saved, for: questionId)
  }

  /// After each state: saved drafts load for asks newly on screen, drafts a
  /// delivered question no longer needs drop, and a closed ask forgets its
  /// drafts, walkthrough and note.
  private func reconcileQuestionItems(closed: [String]) {
    for id in closed {
      itemDraftStore.clear(id)
      itemDrafts[id] = nil
      walkthroughs[id] = nil
      itemNotes[id] = nil
    }
    for (qid, card) in cardBriefs where card.hasQuestionItems {
      let current = itemDrafts[qid] ?? itemDraftStore.load(qid).drafts
      let pruned = FleetQuestionItemsLogic.pruned(current, items: card.questionItems)
      if pruned != (itemDrafts[qid] ?? [:]) { storeItemDrafts(pruned, for: qid) }
      if let index = walkthroughs[qid], !card.questionItems.indices.contains(index) {
        walkthroughs[qid] = max(0, card.questionItems.count - 1)
      }
    }
    // A card that no longer lists questions (an older hub, or now one left).
    for qid in walkthroughs.keys where cardBriefs[qid]?.asksQuestionItems != true {
      walkthroughs[qid] = nil
    }
  }

  // MARK: - State

  func apply(_ state: FleetState) {
    generation &+= 1
    let open = Set(state.questions.map(\.id))
    // A timed-out answer whose question has since closed: say so, since its
    // row (and the "may still be sending" note in it) is about to go.
    for id in stillSending where !open.contains(id) {
      if let old = questions.first(where: { $0.id == id }) { lastOutcome = "\(Self.named(old)): closed." }
      sendingDeadline[id] = nil
    }
    stillSending.formIntersection(open)
    notes = notes.filter { open.contains($0.key) }
    let oldQuestions = questions
    questions = state.questions
    if currentQuestionIndex >= questions.count {
      currentQuestionIndex = max(0, questions.count - 1)
    }
    openQuestionIDs = Set(state.questions.map(\.id))
    cardBriefs = Dictionary(state.cards.map { ($0.questionKey, $0) }, uniquingKeysWith: { first, _ in first })
    reconcileQuestionItems(closed: oldQuestions.map(\.id).filter { !open.contains($0) })
    threads = state.threads
    activityEvents = state.activityEvents
    nextTickAt = state.nextTickAt
    status = state.status
    // The detail screen stays while its question or thread does; a closed
    // question falls back to its thread.
    let keys = Set(state.threads.map(\.key))
    if case let .question(id) = openItem {
      let closed = open.contains(id) ? nil : oldQuestions.first { $0.id == id }
      openItem = FleetOpenItem.reconcile(openItem, closedQuestion: closed, openIDs: open, threadKeys: keys)
      if let item = openItem, item != .question(id) {
        // The result follows the screen to the thread (the draft moves
        // below, as every closed question's does).
        let from = FleetOpenItem.question(id).key
        if let note = replyNotes[from] { replyNotes[item.key] = note }
        // The answer just went to that chat: read it again.
        if case let .thread(key) = item { Task { await loadDetail(key) } }
        // The voice focus follows the screen too, unless it was elsewhere.
        if case let .thread(key) = item, OverlayState.shared.voiceFocus.questionId == id, let thread = state.threads.first(where: { $0.key == key }) {
          OverlayState.shared.selectVoiceContext(.thread(thread))
        }
      }
    } else {
      openItem = FleetOpenItem.reconcile(openItem, closedQuestion: nil, openIDs: open, threadKeys: keys)
    }
    // Any closed question's unsent draft (one left by Back included) moves
    // to its own thread, joined after the thread's own draft if it has one.
    for old in oldQuestions where !open.contains(old.id) {
      let from = FleetOpenItem.question(old.id).key
      guard !replyInFlight.contains(from), let draft = drafts[from], let key = old.threadKey, keys.contains(key) else { continue }
      drafts[FleetOpenItem.thread(key).key] = Self.joinDrafts(drafts[FleetOpenItem.thread(key).key], draft)
    }
    let liveSlots = Set(open.map { FleetOpenItem.question($0).key } + keys.map { FleetOpenItem.thread($0).key })
    // A reply still in flight keeps its draft until its result is known.
    drafts = drafts.filter { liveSlots.contains($0.key) || replyInFlight.contains($0.key) }
    replyNotes = replyNotes.filter { liveSlots.contains($0.key) || replyInFlight.contains($0.key) }
    details = details.filter { keys.contains($0.key) }
    for (key, note) in threadNotes where !keys.contains(key) {
      lastOutcome = "\(key): \(note.text)"
    }
    threadNotes = threadNotes.filter { keys.contains($0.key) }
    // A new scan: the opened row's agent message may have moved on.
    if state.lastTickAt != lastDetailTick, let key = openThreadKey { Task { await loadDetail(key) } }
    lastDetailTick = state.lastTickAt
    hasSupervisor = state.enabled || !state.questions.isEmpty
    // Answering the last question with auto-scan off must not pull the
    // panel to Tasks mid-action and hide the result. The tab goes once the
    // owner leaves it (supervisorTabLeft).
    available = hasSupervisor || OverlayState.shared.tab == .supervisor
    OverlayState.shared.pruneFleetContext(openIDs: open)
    OverlayState.shared.pruneVoiceContext(openIDs: open, threadKeys: keys)
    if state.running { recheckWhileRunning() }
  }

  /// No supervisor on this daemon at all: no tab, even mid-visit.
  private func clearState() {
    generation &+= 1
    questions = []
    openQuestionIDs = []
    cardBriefs = [:]
    threads = []
    activityEvents = []
    nextTickAt = nil
    status = nil
    notes = [:]
    stillSending = []
    sendingDeadline = [:]
    openItem = nil
    drafts = [:]
    pendingReplyImages = [:]
    replyNotes = [:]
    details = [:]
    threadNotes = [:]
    hasSupervisor = false
    available = false
    currentQuestionIndex = 0
    watchingExpanded = false
    // Saved drafts stay on disk: the supervisor may only be away for now.
    itemDrafts = [:]
    walkthroughs = [:]
    itemNotes = [:]
    OverlayState.shared.selectTab(.tasks)
    OverlayState.shared.pruneFleetContext(openIDs: [])
    OverlayState.shared.pruneVoiceContext(openIDs: [], threadKeys: [])
  }

  /// The owner switched to Tasks: a supervisor with nothing to show loses
  /// its tab now, not while they were reading it.
  func supervisorTabLeft() {
    watchingExpanded = false
    if !hasSupervisor { available = false }
  }

  private func recheckWhileRunning() {
    guard runningRecheck == nil else { return }
    runningRecheck = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let self else { return }
      self.runningRecheck = nil
      // Only worth a request while someone is looking at the tab.
      guard OverlayState.shared.expanded, OverlayState.shared.tab == .supervisor else { return }
      await self.refresh()
    }
  }

  /// True when this outreach item is the main's copy of one of this
  /// supervisor's open questions, which the Supervisor tab lists itself.
  /// Matched by id: another node's questions stay on the Tasks tab.
  func lists(_ item: OutreachItem) -> Bool {
    Self.lists(item, available: available, openIDs: openQuestionIDs)
  }

  /// The tab that shows these outreach items: Supervisor only when every one
  /// the Tasks tab would list is a question the Supervisor tab has instead.
  /// Approvals ("pending-action") show above both tabs.
  func tab(showing items: [OutreachItem]) -> OverlayTab {
    Self.tab(showing: items, available: available, openIDs: openQuestionIDs)
  }

  static func lists(_ item: OutreachItem, available: Bool, openIDs: Set<String>) -> Bool {
    guard available, item.type == "fleet-question", item.sourceKind == "fleet",
          let id = item.sourceId else { return false }
    return openIDs.contains(id)
  }

  static func tab(showing items: [OutreachItem], available: Bool, openIDs: Set<String>) -> OverlayTab {
    let listed = items.filter { $0.type != "pending-action" }
    let allListed = listed.allSatisfy { lists($0, available: available, openIDs: openIDs) }
    return !listed.isEmpty && allListed ? .supervisor : .tasks
  }

  /// A network or server failure on a refresh. Silent while the tab is
  /// hidden: most installs have no supervisor, and that is not an error.
  private func refreshFailed() {
    if available { setRefreshError("Couldn't reach the supervisor.") }
  }

  private func setRefreshError(_ message: String?) {
    if let message {
      lastError = message
      refreshOwnsError = true
    } else if refreshOwnsError {
      lastError = nil
      refreshOwnsError = false
    }
  }

  private func setActionError(_ message: String) {
    lastError = message
    refreshOwnsError = false
  }

  private func request(path: String, method: String, timeout: TimeInterval) -> URLRequest {
    var req = URLRequest(url: AppState.buildURL(base: AppState.shared.baseURL, path: path))
    req.httpMethod = method
    req.timeoutInterval = timeout
    if method != "GET" { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let token = AppState.shared.authToken(), !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return req
  }

  // MARK: - Pure helpers (unit-tested)

  /// What an answer or dismissal did, in the owner's words. `isError` rows
  /// render red: the question is still open and nothing reached the agent.
  static func outcome(_ response: FleetQuestionResponse?, dismissed: Bool) -> (text: String, isError: Bool) {
    if dismissed { return ("Dismissed.", false) }
    let detail = response?.delivery?.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
    let shownDetail = (detail?.isEmpty ?? true) ? nil : detail.map { String($0.prefix(300)) }
    let deliveryStatus = response?.delivery?.status
    if deliveryStatus == "queued" {
      return (shownDetail ?? "Saved. It goes to the agent once the Mac can type.", false)
    }
    // Blocked, failed, or "open thread": the supervisor hands it back.
    if response?.question?.status == "open" {
      return (shownDetail ?? "Not sent yet. The question is still open.", true)
    }
    switch deliveryStatus {
    case "sent": return ("Sent to the agent.", false)
    case "dry-run": return ("Saved. Dry run, nothing sent.", false)
    default: return ("Answered.", false)
    }
  }

  /// The Supervisor tab's one status line: "Scanned 4m ago · Propose mode".
  /// The open count is on the tab itself, so it is not repeated here.
  static func statusLine(_ status: FleetStatus, now: Date = Date()) -> String {
    var parts: [String] = []
    if status.running {
      parts.append("Scanning now")
    } else if let at = status.lastTickAt.flatMap(parseDate) {
      parts.append("Scanned \(relative(at, now: now))")
    } else {
      parts.append("Not scanned yet")
    }
    if !status.mode.isEmpty { parts.append(status.mode.prefix(1).uppercased() + status.mode.dropFirst() + " mode") }
    if !status.enabled { parts.append("auto-scan off") }
    return parts.joined(separator: " · ")
  }

  /// A question's age beside its title: "now", "12m", "3h", "2d".
  static func age(_ createdAt: String?, now: Date = Date()) -> String? {
    guard let at = createdAt.flatMap(parseDate) else { return nil }
    return compactAge(seconds(since: at, now: now))
  }

  private static func relative(_ date: Date, now: Date) -> String {
    let elapsed = seconds(since: date, now: now)
    return elapsed < 60 ? "just now" : "\(compactAge(elapsed)) ago"
  }

  private static func seconds(since date: Date, now: Date) -> Int {
    max(0, Int(now.timeIntervalSince(date)))
  }

  private static func compactAge(_ seconds: Int) -> String {
    if seconds < 60 { return "now" }
    if seconds < 3_600 { return "\(seconds / 60)m" }
    if seconds < 86_400 { return "\(seconds / 3_600)h" }
    return "\(seconds / 86_400)d"
  }

  /// A question named in the panel-wide line: its title, in quotes, short.
  private static func named(_ question: FleetQuestion) -> String {
    let title = question.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\u{201C}\(title.count > 60 ? String(title.prefix(59)) + "\u{2026}" : title)\u{201D}"
  }

  private static func parseDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
  }

  private static func serverError(_ data: Data) -> String? {
    guard let message = (try? JSONDecoder().decode(FleetErrorBody.self, from: data))?.error?
      .trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty else { return nil }
    return String(message.prefix(300))
  }
}
