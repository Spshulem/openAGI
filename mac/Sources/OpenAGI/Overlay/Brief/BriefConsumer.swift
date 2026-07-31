import Foundation

// Fetches GET /brief/today from the LOCAL daemon and dispatches an item's
// declarative actions back to it.
//
// Refresh model (pinned deliberately — three different precedents exist in
// this codebase): fetch on panel expand and on the SSE events that can change
// the brief. No timer. After a successful action the row is removed
// optimistically and a single refetch reconciles; on failure that ONE row is
// restored and the server's message is surfaced.
@MainActor
final class BriefConsumer: ObservableObject {
  static let shared = BriefConsumer()

  @Published private(set) var items: [BriefItem] = []
  @Published private(set) var olderCount: Int = 0
  @Published private(set) var isLoading = false
  @Published private(set) var lastError: String? = nil
  /// The last action's server-reported outcome ("Task added", "Skill created: …").
  /// Kept SEPARATE from `lastError` on purpose: `act()` refetches immediately and
  /// `refresh()` nils `lastError` on success, so an outcome parked there would be
  /// wiped before it ever rendered. Nothing clears this but the next action.
  @Published private(set) var lastOutcome: String? = nil
  /// Action ids currently in flight, keyed by item id. `accept` is NOT
  /// idempotent server-side (skill materialization dedupes into slug-2,
  /// slug-3), so a double tap must be impossible.
  @Published private(set) var inFlight: Set<String> = []
  /// Stores the daemon could not read on this fetch ("suggestions", "tasks", …).
  /// The server reports this explicitly (GET /brief/today -> `degraded`) so the
  /// popover can say "I could not look" instead of the confident lie "Nothing
  /// needs you right now." Discarding it re-told that lie client-side.
  @Published private(set) var degraded: [String] = []
  /// When today's pinned plan artifact was cached, or nil when the 08:00 cron
  /// has not written one. Free from the same decode; provenance for the header.
  @Published private(set) var planCachedAt: String? = nil

  /// True when BriefSection would render anything at all. The overlay gates the
  /// whole section on this rather than on `items`, so an outcome, an error, a
  /// degraded store, an in-flight tap, or the "N older" count still shows once
  /// the last row has been acted on.
  ///
  /// `inFlight` is in here for a specific reason: `act()` removes the row
  /// optimistically WITHOUT touching `isLoading`, so acting on the last item
  /// would otherwise drive this to false and unmount the section (and its
  /// Divider) for the whole request, then remount when the outcome lands.
  var hasContent: Bool {
    !items.isEmpty || isLoading || olderCount > 0 || lastError != nil
      || lastOutcome != nil || !degraded.isEmpty || !inFlight.isEmpty
  }

  private var baseURL: URL { AppState.shared.baseURL }
  private func token() -> String? { AppState.shared.authToken() }

  /// Monotonic fetch id. RULE: only the NEWEST fetch may publish. `refresh()`
  /// has three independent triggers (panel expand, post-action reconcile, SSE),
  /// so two fetches are routinely in flight at once and the network can return
  /// them out of order — without this, a slow older response lands last and
  /// overwrites newer state (last-writer-wins on a stale body).
  private var refreshGeneration: UInt64 = 0
  /// RULE: the loading flag is a DEPTH counter, not a boolean. Overlapping
  /// refreshes each own one `defer`, and an inner one finishing must not clear
  /// the spinner an outer one is still waiting on.
  private var loadingDepth = 0

  func refresh() async {
    refreshGeneration &+= 1
    let generation = refreshGeneration
    loadingDepth += 1
    isLoading = true
    defer {
      loadingDepth = max(0, loadingDepth - 1)
      isLoading = loadingDepth > 0
    }
    do {
      var req = URLRequest(url: AppState.buildURL(base: baseURL, path: "/brief/today?limit=5"))
      req.timeoutInterval = 6
      if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
      let (data, resp) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(resp, data)
      let decoded = try JSONDecoder().decode(BriefResponse.self, from: data)
      guard generation == refreshGeneration else { return }  // a newer fetch already won
      items = decoded.items
      olderCount = decoded.older.count
      degraded = decoded.degraded
      planCachedAt = decoded.planCachedAt
      lastError = nil
      // The list just changed under the inline editor. Deliberately NOT in the
      // catch branch: a transport failure says nothing about which rows exist,
      // `items` is left stale, and closing an editor on that would discard a
      // revision over a dropped packet.
      BriefEditorState.shared.reconcile(items: items, inFlight: inFlight)
    } catch {
      guard generation == refreshGeneration else { return }
      lastError = error.localizedDescription
      // A transport failure says NOTHING about which stores the daemon could
      // read. Leaving a stale list parked would stack a second lie on top of
      // the error the user is already being shown.
      degraded = []
    }
  }

  func act(_ item: BriefItem, _ action: BriefAction) async {
    guard !inFlight.contains(item.id) else { return }
    inFlight.insert(item.id)
    // Clearing `inFlight` is what makes the acted row's fate knowable, so it is
    // also the moment the editor's anchor can finally be decided. Both happen
    // here, together, on every exit path — including the throwing one.
    defer {
      inFlight.remove(item.id)
      BriefEditorState.shared.reconcile(items: items, inFlight: inFlight)
    }

    // RULE: never snapshot the whole array across an await. `inFlight` is keyed
    // per item, so two rows can be acted on concurrently; restoring a
    // whole-array snapshot on failure would resurrect rows the other call
    // already removed (with their buttons stuck disabled) and silently delete
    // rows the user never touched. Exactly one row was acted on here, so
    // exactly one row is what failure may put back — at its old position.
    let acted = item
    let actedIndex = items.firstIndex { $0.id == item.id } ?? items.count

    lastOutcome = nil                      // the previous action's result is stale now
    // An expand- or SSE-triggered refresh already in flight was BUILT before
    // this decision and still carries the row being removed, so letting it land
    // re-adds a row the user just acted on (and, with the editor open on it,
    // re-mounts the field and steals focus). Bumping the generation retires it
    // exactly the way a newer refresh would; act() then does its own refetch on
    // success, so nothing is left unreconciled.
    refreshGeneration &+= 1
    items.removeAll { $0.id == item.id }   // optimistic

    do {
      var req = URLRequest(url: AppState.buildURL(base: baseURL, path: action.path))
      req.httpMethod = action.method
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.timeoutInterval = 10
      if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
      if let body = action.body {
        // Encode THROUGH AnyCodable, not around it. Reaching past it with
        // JSONSerialization over `.value` left two encoders for one wire
        // format: AnyCodable.encode already had to be fixed once for nested
        // containers, and this path would not have inherited that fix. One
        // encoder means a body can only ever be wrong in one place.
        req.httpBody = try JSONEncoder().encode(body)
      } else if action.method != "DELETE" {
        req.httpBody = "{}".data(using: .utf8)
      }
      let (data, resp) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(resp, data)
      lastOutcome = outcomeMessage(data, action: action)
      await refresh()
    } catch {
      // The decision was not recorded — put this one row back where it was,
      // unless a refresh that finished meanwhile already restored it.
      if !items.contains(where: { $0.id == acted.id }) {
        items.insert(acted, at: min(actedIndex, items.count))
      }
      lastError = error.localizedDescription
    }
  }

  /// What to tell the user after an action, dispatched on the ACTION THAT WAS
  /// SENT — never on whatever keys happen to be in the response body.
  ///
  /// RULE: the response bodies are NOT distinguishable by shape.
  /// POST /drafts/:id/approve and /drafts/:id/discard return the same draft
  /// object, and every draft carries a top-level `taskId` (src/draft-store.js),
  /// so key-sniffing reported "Task added" when the user tapped Discard.
  /// POST /tasks/:id/complete and PATCH /tasks/:id return a task keyed `id`,
  /// /tasks/clarifications/:id/answer returns {clarification, task}, and
  /// /proactive/suggestions/:id/reject returns the bare candidate — all three
  /// matched nothing and confirmed nothing. Only the REQUEST knows what was asked.
  ///
  /// The one thing that must still be read out of the body is failure:
  /// POST /proactive/suggestions/:id/accept genuinely reports materialization
  /// failures as 200s carrying taskCreateError / skillCreateError /
  /// registerError, so the error sweep runs FIRST, for every action.
  private func outcomeMessage(_ data: Data, action: BriefAction) -> String? {
    // An unreadable/absent body degrades to an empty object: every lookup below
    // simply misses and the action still gets its own message.
    let obj = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
    for key in ["taskCreateError", "skillCreateError", "registerError", "memoryCreateError", "error"] {
      if let msg = obj[key] as? String, !msg.isEmpty { return "Failed: \(msg)" }
    }

    switch action.id {
    case "accept" where isSuggestionPath(action.path):
      // ONLY this route returns these keys as a success report. Elsewhere a
      // taskId is just the row's provenance, not something that was created.
      if let mcp = obj["registered"] as? String { return mcpOutcome(mcp, obj) }
      if let slug = obj["skillSlug"] as? String { return "Skill created: \(slug)" }
      if obj["taskId"] is String { return "Task added" }
      // A "knowledge" suggestion is written into the memory store
      // (src/hosted-interface.js -> commit({ memoryId, memoryTier })). Without
      // this it fell through to the generic "Suggestion accepted", which is
      // true but does not tell the user the thing was actually remembered.
      if obj["memoryId"] is String { return "Remembered" }
      return "Suggestion accepted"

    case "reject" where isSuggestionPath(action.path):
      return "Suggestion dismissed"

    case "approve" where isDraftPath(action.path):
      return "Draft approved"

    case "discard" where isDraftPath(action.path):
      return "Draft discarded"

    // The two discards must not report the same thing, because they DID not do
    // the same thing: plain Discard resolves the artifact and leaves the task
    // free to draft again (which is why the user's discards kept coming back),
    // "Stop asking" also retires the generating task.
    //
    // Which branch we are in is decided by the ACTION, as everywhere else here.
    // The body is then read only to answer a question the action cannot: the
    // route reports the draft half and the task half separately, because the
    // task can be gone, already completed, or unwritable while the draft was
    // still discarded fine. "Won't ask again" is a claim about the task, so it
    // is made only when the server says a task was actually retired.
    case "stop_asking" where isDraftPath(action.path):
      if obj["retired"] is [String: Any] { return "Discarded — won't ask again" }
      if let why = (obj["retireError"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty {
        // Prefixed "Failed" so BriefSection renders it red: the draft is gone,
        // but the thing the user actually asked for — make it stop — did not
        // happen, and they need to know it will be back.
        return "Failed: discarded, but couldn't stop the task — \(why)"
      }
      return "Discarded — no task left to stop"

    case "complete" where isTaskPath(action.path):
      return "Marked done"

    case "snooze" where isTaskPath(action.path):
      // Say where it actually landed: the response is the updated task, so the
      // bucket the server applied beats the one we asked for.
      if let bucket = (obj["bucket"] as? String) ?? (action.body?["bucket"]?.value as? String) {
        return "Snoozed to \(bucket.replacingOccurrences(of: "_", with: " "))"
      }
      return "Snoozed"

    case let id where id.hasPrefix("answer:") && isClarificationPath(action.path):
      // The store resolves the clarification even when its task is already gone
      // (it returns {clarification, task: null}), so only claim the task moved
      // when the response actually carries one.
      let movedTask = obj["task"] is [String: Any]
      switch String(id.dropFirst("answer:".count)) {
      case "yes": return movedTask ? "Marked done" : "Answered"
      case "in_progress": return movedTask ? "Marked in progress" : "Answered"
      case "no": return movedTask ? "Kept on your list" : "Answered"
      case "dropped": return movedTask ? "Dropped" : "Answered"
      default: return genericOutcome(action)
      }

    default:
      return genericOutcome(action)
    }
  }

  /// Accepting an MCP suggestion does two separable things: it WRITES the
  /// server into the registry, and it then tries to CONNECT to it. `registered`
  /// only ever proved the first, yet this reported "Connected <name>" — so a
  /// server that was written down and never reached still read as working, and
  /// the user learned otherwise the next time a tool call went missing.
  ///
  /// The accept response now carries the second half explicitly
  /// (`connected` + `connectError`), and these four cases are exactly what it
  /// can say. Note `connected` is read as `Bool?`, not `?? false`: ABSENT is a
  /// third state, not a no. An older daemon sends neither field, and it did
  /// attempt the connection — so the honest report is the half we can prove
  /// ("Registered X") with no claim either way about the connection.
  private func mcpOutcome(_ name: String, _ obj: [String: Any]) -> String {
    let connected = obj["connected"] as? Bool
    // `connected` is checked BEFORE `connectError`, which is the opposite of
    // the web toast in hosted-interface.js. The server builds both from one
    // return (`{ connected: isConnected(), connectError: … }`), so a retry that
    // threw against an ALREADY-connected server yields true alongside an error
    // string. The tools are live in that case; "connect failed" would be the
    // wrong half to report.
    if connected == true { return "Connected \(name)" }
    // Prefixed "Failed" so BriefSection renders it red: the registry entry
    // landed, but the thing the user actually asked for did not happen.
    if let why = (obj["connectError"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty {
      return "Failed: registered \(name), couldn't connect — \(why)"
    }
    if connected == false { return "Registered \(name) — not connected" }
    return "Registered \(name)"
  }

  /// Nothing may be silent. An action this build does not recognize — a newer
  /// daemon's, or a known id on an unexpected path — still confirms itself with
  /// the server-supplied label, which is the only thing we can honestly claim.
  private func genericOutcome(_ action: BriefAction) -> String {
    let label = action.label.trimmingCharacters(in: .whitespacesAndNewlines)
    return label.isEmpty ? "Done" : "\(label) — done"
  }

  private func isSuggestionPath(_ path: String) -> Bool { path.contains("/proactive/suggestions/") }
  private func isDraftPath(_ path: String) -> Bool { path.contains("/drafts/") }
  private func isClarificationPath(_ path: String) -> Bool { path.contains("/tasks/clarifications/") }
  /// Must not match the clarification route, which also lives under /tasks/.
  private func isTaskPath(_ path: String) -> Bool {
    path.contains("/tasks/") && !path.contains("/tasks/clarifications/")
  }
}
