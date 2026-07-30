import SwiftUI

/// Which brief row has its inline editor open, and what is typed into it.
///
/// This is a shared ObservableObject rather than @State inside BriefSection for
/// one concrete reason: the overlay panel is sized MANUALLY, from an .onChange
/// allowlist in OverlayView. A view's private @State is invisible to that list,
/// so opening an editor — or typing a body onto a second line — would grow the
/// content inside a panel that never re-measured, and the field would render
/// clipped with its Save button off the bottom edge.
@MainActor
final class BriefEditorState: ObservableObject {
  static let shared = BriefEditorState()

  /// item.id whose editor is open, or nil when none is.
  @Published private(set) var openItemID: String? = nil
  /// The text being edited. Seeded ONLY from the item's full `editValue`.
  @Published var text: String = ""
  /// The seed `text` was opened with, so "the user has typed" can be told from
  /// "this is still exactly what the server sent". Not @Published: it is
  /// bookkeeping, it changes nothing on screen, and publishing it would fire
  /// OverlayView's resize allowlist for a value no pixel depends on.
  private var openSeed: String? = nil

  /// Open `item`'s editor, seeded with its complete current text.
  ///
  /// Returns false and opens NOTHING when the item carries no seed. That guard
  /// is the whole safety story of this feature: an editor that opens empty (or
  /// on a truncated preview) submits that over a real draft and destroys the
  /// rest of it, so with no trustworthy seed the right answer is no editor.
  @discardableResult
  func open(_ item: BriefItem) -> Bool {
    guard let seed = item.editValue else { return false }
    text = seed
    openSeed = seed
    openItemID = item.id
    return true
  }

  func close() {
    openItemID = nil
    text = ""
    openSeed = nil
  }

  func isOpen(_ item: BriefItem) -> Bool { openItemID == item.id }

  /// Keep the editor anchored to a row that still exists.
  ///
  /// `close()` used to be the ONLY thing that cleared `openItemID`, and nothing
  /// calls it when the row leaves by any other route — Approve, Discard, or a
  /// refresh that simply no longer lists the item. The id then stayed pinned to
  /// a draft that was gone while `text` still held the user's typed body.
  ///
  /// That is not merely untidy, because a removed row can come BACK: act()
  /// restores it when the request throws, and a refresh can list it again. On
  /// that revival `isOpen` matches once more, the field re-mounts on a seed
  /// captured before the item left, and `.onAppear` yanks keyboard focus out of
  /// the Quick Ask field with no user action — one Return away from PATCHing a
  /// stale body over whatever the draft says now. (It cannot reach a DIFFERENT
  /// draft: both the id and the PATCH path come from the same live BriefItem,
  /// and draft ids are `draft_<uuid>`, never reused. Stale, not misdirected.)
  ///
  /// Called from BriefConsumer whenever `items` or `inFlight` moves, so this
  /// holds even while the panel is collapsed and no brief view is mounted.
  func reconcile(items: [BriefItem], inFlight: Set<String>) {
    guard let open = openItemID else { return }
    // A row with an action in flight is NOT gone — act() removes it
    // optimistically and puts it back if the request throws. Deciding here
    // would discard the user's revision on every failed Approve. act()'s defer
    // clears `inFlight` and calls back, which is when the answer is known.
    if inFlight.contains(open) { return }
    guard let live = items.first(where: { $0.id == open }) else { close(); return }
    // Still listed, but the daemon no longer sends a body for it. Same rule as
    // open(): no trustworthy seed, no editor — never a PATCH built on a guess.
    guard let seed = live.editValue else { close(); return }
    // The row's text moved server-side and the user had not touched theirs:
    // follow the live item instead of holding a snapshot of a version that no
    // longer exists. A body the user HAS typed is never overwritten — their
    // edit is the newer one, and losing it is the failure this whole type is
    // built to avoid.
    if seed != openSeed && text == openSeed {
      text = seed
      openSeed = seed
    }
  }
}

// Renders the ranked brief. Every button comes from the server's declarative
// `actions`, so this view has no per-kind switch and needs no change when a
// new source is added server-side.
struct BriefSection: View {
  @ObservedObject var brief = BriefConsumer.shared
  @ObservedObject var editor = BriefEditorState.shared
  @FocusState private var editorFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text("TODAY").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        if !brief.items.isEmpty {
          Text("\(brief.items.count) things").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        Spacer()
        if brief.isLoading { ProgressView().controlSize(.small) }
      }

      // "Nothing needs you right now." is a claim about the WORLD, and it is
      // only true if every store was actually read. When `degraded` is
      // non-empty the daemon could not look at one of them, so an empty list
      // means "I don't know", not "nothing" — say the former (below) instead of
      // asserting the latter.
      if brief.items.isEmpty && !brief.isLoading && brief.degraded.isEmpty {
        Text("Nothing needs you right now.").font(.system(size: 11)).foregroundStyle(.tertiary)
      }

      ForEach(brief.items) { item in
        row(item)
      }

      // THREE distinct status channels, deliberately not merged:
      //
      //  1. lastError (red) — the request itself failed. Nothing was fetched,
      //     so the rows on screen are whatever survived from before.
      //  2. lastOutcome (secondary; red when prefixed "Failed") — what the LAST
      //     ACTION did. The accept endpoint reports failures as 200s with a
      //     *Error field, so outcomeMessage prefixes those and they must still
      //     read as failures despite the HTTP success.
      //  3. degraded (orange) — the request SUCCEEDED but the daemon could not
      //     read one of its stores, so the brief is honest-but-incomplete. Not
      //     an error (every row shown is real) and not an outcome (no action
      //     ran); it is purely the difference between "nothing is pending" and
      //     "I couldn't look". Warning colour, not red, for exactly that reason.
      if let err = brief.lastError {
        Text(err).font(.system(size: 10)).foregroundStyle(.red).lineLimit(2)
      }
      if let outcome = brief.lastOutcome {
        Text(outcome).font(.system(size: 10))
          .foregroundStyle(outcome.hasPrefix("Failed") ? .red : .secondary)
          .lineLimit(2)
      }
      if !brief.degraded.isEmpty {
        Text("Couldn't read: \(degradedSources)")
          .font(.system(size: 10)).foregroundStyle(.orange).lineLimit(2)
      }

      if brief.olderCount > 0 {
        Text("▾ \(brief.olderCount) older").font(.system(size: 10)).foregroundStyle(.tertiary)
      }
    }
  }

  @ViewBuilder private func row(_ item: BriefItem) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .top, spacing: 5) {
        Text(icon(item.kind)).font(.system(size: 11))
        Text(item.title).font(.system(size: 12, weight: .semibold)).lineLimit(2)
      }
      if !item.why.isEmpty {
        Text(item.why).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
      }
      if !item.actions.isEmpty {
        HStack(spacing: 6) {
          ForEach(item.actions) { action in
            actionButton(item, action)
          }
        }
      }
      if editor.isOpen(item) {
        editorField(item)
      }
    }
  }

  /// Most actions dispatch on tap. A "revise" action does NOT: it has no body
  /// of its own to send (the server sends `body: null` and names the key it
  /// wants filled in `bodyField`), so dispatching it on tap would PATCH the
  /// draft with an empty object. It opens the inline editor instead, and the
  /// dispatch happens on submit.
  @ViewBuilder private func actionButton(_ item: BriefItem, _ action: BriefAction) -> some View {
    if action.style == "revise" {
      Button(action.label) {
        if editor.isOpen(item) { editor.close() } else { editor.open(item) }
      }
      .buttonStyle(.borderless)
      .font(.system(size: 11))
      .foregroundStyle(tint(action.style))
      // Disabled rather than hidden when there is no seed: a newer daemon can
      // offer a revise on a row this build received no `editValue` for, and
      // quietly dropping the button would leave the user hunting for the "change
      // this" they were told exists. Say why instead — and never open on a seed
      // we do not have.
      .disabled(item.editValue == nil || brief.inFlight.contains(item.id))
      .help(item.editValue == nil
            ? "This daemon didn't send the draft's text, so it can't be edited here."
            : "Edit the draft before approving it")
    } else {
      Button(action.label) { Task { await brief.act(item, action) } }
        .buttonStyle(.borderless)
        .font(.system(size: 11))
        .foregroundStyle(tint(action.style))
        .disabled(brief.inFlight.contains(item.id))
    }
  }

  /// The inline editor: the draft's real body, editable in place.
  @ViewBuilder private func editorField(_ item: BriefItem) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      // axis: .vertical is load-bearing, not cosmetic. A draft body is
      // multi-line; a single-line TextField would flatten the newlines it was
      // seeded with, and submitting that would silently reformat the user's
      // draft into one paragraph.
      TextField("Draft body", text: $editor.text, axis: .vertical)
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 11))
        .lineLimit(3...8)
        .focused($editorFocused)
        .onSubmit { submitEdit(item) }
      HStack(spacing: 6) {
        Button("Save") { submitEdit(item) }
          .buttonStyle(.borderless).font(.system(size: 11)).foregroundStyle(.blue)
          // An all-whitespace body is a deletion wearing an edit's clothes:
          // draft-store.edit() writes whatever it is given, so refuse it here.
          .disabled(brief.inFlight.contains(item.id) || isBlank(editor.text))
        Button("Cancel") { editor.close() }
          .buttonStyle(.borderless).font(.system(size: 11)).foregroundStyle(.secondary)
          .disabled(brief.inFlight.contains(item.id))
        Spacer()
        // ⌥↩ is spelled out because Return is bound to save here: a draft body
        // is multi-line and the user needs to know how to add a line to it.
        Text("↩ save · ⌥↩ newline · esc cancel").font(.system(size: 9)).foregroundStyle(.tertiary)
      }
    }
    // Escape while the field has focus closes the EDITOR. Without this the
    // panel's own cancelOperation (KeyableOverlayPanel) sees it first and
    // collapses the whole overlay, which is not what "cancel this edit" means.
    .onExitCommand { editor.close() }
    .onAppear { editorFocused = true }
  }

  /// Send the edit: the action's own body merged with the typed text under the
  /// key the SERVER named (`bodyField`), then handed to BriefConsumer.act() —
  /// the same path every other action takes, so it inherits the double-tap
  /// guard, the restore-on-failure and the post-action refresh rather than
  /// re-implementing them here.
  private func submitEdit(_ item: BriefItem) {
    guard let action = item.actions.first(where: { $0.style == "revise" }) else { return }
    let typed = editor.text
    guard !isBlank(typed) else { return }
    var body = action.body ?? [:]
    body[action.bodyField ?? "body"] = AnyCodable(typed)
    let dispatch = BriefAction(
      id: action.id, label: action.label, style: action.style,
      method: action.method, path: action.path, body: body, bodyField: action.bodyField
    )
    Task {
      await brief.act(item, dispatch)
      // Whatever happened, it is only ours to act on if this is still the open
      // editor — never close or steal focus from one the user opened meanwhile.
      guard editor.isOpen(item) else { return }
      // Close ONLY on a confirmed save. act() clears lastOutcome before the
      // request and only sets it once the server answered, so a failed PATCH
      // leaves the editor open with the user's text still in it — throwing away
      // a revision the daemon refused would be its own small data loss.
      let saved = brief.lastOutcome.map { !$0.hasPrefix("Failed") } ?? false
      if saved { editor.close() } else { editorFocused = true }
    }
  }

  private func isBlank(_ s: String) -> Bool {
    s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The server's raw source keys, rendered as words a person recognises.
  /// Order is the server's; duplicates are collapsed so a source reported by
  /// both the `safely()` boundary and the unreadable-store probe reads once.
  private var degradedSources: String {
    var seen = Set<String>()
    return brief.degraded
      .filter { seen.insert($0).inserted }
      .map { humanSource($0) }
      .joined(separator: ", ")
  }

  /// An UNKNOWN key is shown verbatim rather than dropped. A newer daemon can
  /// name a source this build has never heard of, and silently omitting it
  /// would re-introduce the same lie this whole channel exists to fix.
  private func humanSource(_ key: String) -> String {
    switch key {
    case "plan": return "today's plan"
    case "tasks": return "tasks"
    case "drafts": return "drafts"
    case "clarifications": return "questions"
    case "suggestions": return "suggestions"
    case "preferences": return "your preferences"
    default: return key
    }
  }

  private func icon(_ kind: String) -> String {
    switch kind {
    case "focus": return "🎯"
    case "task": return "✓"
    case "suggestion": return "💡"
    case "draft": return "📝"
    case "clarification": return "❓"
    default: return "•"
    }
  }

  private func tint(_ style: String) -> Color {
    switch style {
    case "primary": return .blue
    case "destructive": return .red
    default: return .secondary
    }
  }
}
