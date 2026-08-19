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
  /// item.id whose body is expanded READ-ONLY, or nil when none is.
  ///
  /// Separate from `openItemID` because reading and rewriting are different
  /// jobs and the common one is reading. The user's words: "I wish I could just
  /// hit View or click on it and be able to see it instead of just approve and
  /// discard." Approving something you cannot read is the actual defect; the
  /// editor was the only way to see a body, it did not scroll, and draft bodies
  /// on the real install run to 14,279 characters.
  ///
  /// @Published for the same reason as `openItemID`: the panel is sized from an
  /// .onChange allowlist in OverlayView, and expanding a body changes the
  /// rendered height. Private @State here would be invisible to that list and
  /// the body would render clipped.
  @Published private(set) var expandedItemID: String? = nil
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
    // The editor shows the same text the read-only view does, scrollably. Two
    // copies of one body stacked in a 320pt popover is noise, so opening the
    // editor takes over from the preview.
    expandedItemID = nil
    return true
  }

  func close() {
    openItemID = nil
    text = ""
    openSeed = nil
  }

  func isOpen(_ item: BriefItem) -> Bool { openItemID == item.id }

  /// Show/hide `item`'s body read-only. Never touches the editor's `text`: an
  /// expansion carries no user input, so toggling it can't lose anything —
  /// which is exactly why it, and not the editor, is what a tap on the title
  /// opens.
  func toggleExpanded(_ item: BriefItem) {
    guard item.editValue != nil else { return }  // nothing to reveal
    expandedItemID = (expandedItemID == item.id) ? nil : item.id
  }

  /// Unconditional close, for the paths that mean "put this away" rather than
  /// "flip it" — Escape, most of all. A toggle bound to Escape would OPEN the
  /// preview if it ever fired while closed, which is the opposite of what the
  /// key means.
  func collapse() { expandedItemID = nil }

  func isExpanded(_ item: BriefItem) -> Bool { expandedItemID == item.id }

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
    // The read-only preview needs the same anchoring, for the milder version of
    // the same reason: a body left expanded under a row that has been approved
    // or discarded is a panel-sized block of text describing something that no
    // longer exists. No typed input is at stake here, so the rule is simply
    // "gone and not in flight -> collapse".
    if let shown = expandedItemID, !inFlight.contains(shown),
       !items.contains(where: { $0.id == shown && $0.editValue != nil }) {
      expandedItemID = nil
    }
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
  @ObservedObject var overlay = OverlayState.shared
  /// Only for `openDashboard` — the escape hatch out of the popover to the full
  /// artifact. Observed rather than reached for statically so this view follows
  /// the same convention as OverlayView.
  @ObservedObject var app = AppState.shared
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
        Button {
          app.openDashboard(path: "/?tab=review")
        } label: {
          HStack(spacing: 4) {
            Text(brief.olderDisclosureLabel)
              .lineLimit(2)
              .multilineTextAlignment(.leading)
            Image(systemName: "arrow.up.right")
              .font(.system(size: 8, weight: .semibold))
          }
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Open and search every pending task, draft, clarification, and suggestion")
        .accessibilityLabel("Open remaining items: \(brief.olderDisclosureLabel)")
      }
    }
  }

  /// One brief row. The action list is split in two, deliberately.
  ///
  /// A draft now offers Edit / Approve / Discard AND "Stop asking", and those
  /// last two are one tap apart while meaning very different things — Discard
  /// resolves this draft (the task may legitimately produce a better one later),
  /// "Stop asking" retires the task so it never drafts again. Discard is the
  /// common case and keeps its place in the tap row at full weight; anything the
  /// server marks `style: "retire"` drops to its own line underneath, smaller
  /// and unaccented, so the deliberate choice cannot be collected by a thumb
  /// aimed at the common one.
  ///
  /// Not a modal and not a second tap: the panel is 320pt of manually-sized
  /// popover, a confirm sheet has nowhere to live in it, and a two-step Discard
  /// would tax the action the user takes most to protect the one they take
  /// rarely. Separation plus a truthful outcome line plus a reversible server
  /// action is the trade this makes instead.
  private func row(_ item: BriefItem) -> some View {
    let inline = item.actions.filter { !isDeliberate($0) }
    let deliberate = item.actions.filter { isDeliberate($0) }
    let readable = item.editValue != nil && !editor.isOpen(item)
    return VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .top, spacing: 4) {
        titleLine(item, readable: readable)
        Menu { itemMenu(item) } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: 18, height: 18)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More actions")
      }
      if !item.why.isEmpty {
        Text(item.why).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
      }
      if !inline.isEmpty || readable {
        HStack(spacing: 6) {
          // "View" leads. It is the question the user actually has in front of
          // a draft — "what IS this?" — and it was the one thing the row could
          // not answer. Client-side and keyed off `editValue`, not `kind`: the
          // body is already on the wire, so this needs no new server action, no
          // new route, and cannot disagree with a daemon of another version.
          if readable { viewButton(item) }
          ForEach(inline) { action in
            actionButton(item, action)
          }
        }
      }
      if !deliberate.isEmpty {
        HStack(spacing: 6) {
          ForEach(deliberate) { action in
            deliberateButton(item, action)
          }
        }
      }
      if editor.isExpanded(item), let body = item.editValue {
        bodyPreview(item, body)
      }
      if editor.isOpen(item) {
        editorField(item)
      }
    }
    .contentShape(Rectangle())
    .contextMenu { itemMenu(item) }
  }

  /// The visible ellipsis and the native right-click menu deliberately share
  /// one builder so their capabilities cannot drift apart.
  @ViewBuilder private func itemMenu(_ item: BriefItem) -> some View {
    Button("Chat about this") { overlay.chatAbout(item) }
    Button("Add related task…") { overlay.addRelatedTask(to: item) }
    Button("Open in dashboard") { app.openDashboard(path: item.deepLink) }
    if !item.menuActions.isEmpty {
      Divider()
      Menu("Move to") {
        ForEach(item.menuActions) { action in
          Button(action.label) { Task { await brief.act(item, action) } }
            .disabled(brief.inFlight.contains(item.id))
        }
      }
    }
  }

  /// The row's headline. Tapping it expands the body when there is one —
  /// the gesture the user reached for ("click on it and be able to see it").
  ///
  /// A tap target with no visual affordance is a secret, so a chevron marks the
  /// rows that have one and the plain rows keep the plain title they had.
  /// TRUNCATION: `lineLimit(2)` is right for a list and wrong for reading — the
  /// longest pending draft title on the real install is 86 characters, which
  /// does not fit two lines of 12pt in a 320pt panel. Expanding lifts the cap,
  /// so the full title and the full body arrive by the same tap.
  @ViewBuilder private func titleLine(_ item: BriefItem, readable: Bool) -> some View {
    let expanded = editor.isExpanded(item)
    HStack(alignment: .top, spacing: 5) {
      Text(icon(item.kind)).font(.system(size: 11))
      if readable || expanded {
        Button {
          editor.toggleExpanded(item)
        } label: {
          HStack(alignment: .top, spacing: 4) {
            Text(item.title)
              .font(.system(size: 12, weight: .semibold))
              .lineLimit(expanded ? nil : 2)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(.tertiary)
              .padding(.top, 3)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(expanded ? "Hide the full text" : "Show the full text")
      } else {
        Button { overlay.chatAbout(item) } label: {
          Text(item.title)
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Chat about this item")
      }
    }
  }

  /// The explicit twin of the tappable title. Both are here on purpose: the
  /// title is the gesture people try first, and a labelled button is the one
  /// they can find. It sits in the action row so "what is this?" is offered
  /// beside "approve it", which is the pairing that was missing.
  @ViewBuilder private func viewButton(_ item: BriefItem) -> some View {
    Button(editor.isExpanded(item) ? "Hide" : "View") {
      editor.toggleExpanded(item)
    }
    .buttonStyle(.borderless)
    .font(.system(size: 11))
    .foregroundStyle(.secondary)
    .help("Read the full text before deciding on it")
  }

  /// The draft's real body, read-only and SCROLLABLE.
  ///
  /// Scrolling is the entire point. Bodies here reach 14,279 characters, so
  /// "just render it all" is not an option and truncating would answer "what IS
  /// this?" with a fragment. `maxHeight` bounds the box and the ScrollView keeps
  /// every character inside it reachable.
  ///
  /// It renders BELOW the action row, and that ordering is load-bearing: the
  /// buttons the user came to press stay pinned above a block of text that can
  /// be a hundred lines long, so reading can never push Approve/Discard off the
  /// bottom of a manually-sized panel.
  ///
  /// Read-only, and `textSelection(.enabled)` rather than editable: this view
  /// exists so a decision can be made from the whole text, and it must not be
  /// possible to nudge a character into a draft while reading it.
  @ViewBuilder private func bodyPreview(_ item: BriefItem, _ body: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      ScrollView {
        Text(body)
          .font(.system(size: 11))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(6)
      }
      .frame(maxHeight: 150)
      .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.05)))
      .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
      HStack(spacing: 8) {
        // The escape hatch out of a 320pt popover. `deepLink` has been on the
        // wire since the first version of this section and nothing in the app
        // had ever used it, so until now there was NO route from a brief row to
        // the full artifact — the dashboard's Today tab renders every pending
        // draft in a resizable textarea. It does now.
        Button("Open in dashboard") { app.openDashboard(path: item.deepLink) }
          .buttonStyle(.borderless).font(.system(size: 10)).foregroundStyle(.blue)
        Spacer()
        Text("scroll to read · select to copy").font(.system(size: 9)).foregroundStyle(.tertiary)
      }
    }
    // Escape closes the preview rather than collapsing the whole overlay, the
    // same bargain the editor strikes with KeyableOverlayPanel's cancelOperation.
    .onExitCommand { editor.collapse() }
  }

  /// A "retire"-styled action: consequential, rare, and never adjacent to the
  /// button it must not be confused with. Recognised by STYLE, not id, so a
  /// newer daemon can mark any action this way without a client change — and an
  /// id-based list here would have gone stale the first time it did.
  private func isDeliberate(_ action: BriefAction) -> Bool { action.style == "retire" }

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

  /// The de-emphasised second line. Same single tap as everything else — the
  /// weight is carried by position, size and colour rather than by an extra
  /// step. The ⊘ is there so the line reads as "off switch" at a glance in a
  /// 10pt font, and `.help` spells out the part a two-word label cannot: that
  /// this reaches past the draft to the task, and that it can be undone.
  @ViewBuilder private func deliberateButton(_ item: BriefItem, _ action: BriefAction) -> some View {
    Button {
      Task { await brief.act(item, action) }
    } label: {
      Text("⊘ \(action.label)")
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
    }
    .buttonStyle(.plain)
    .disabled(brief.inFlight.contains(item.id))
    .help("Also retires the task that keeps producing this, so it can't come back. Undo it from the Tasks tab.")
  }

  /// The inline editor: the draft's real body, editable in place.
  ///
  /// TextEditor, not TextField(axis: .vertical). The vertical TextField GREW to
  /// its `lineLimit` ceiling and then simply stopped: past eight lines the rest
  /// of the body was neither visible nor reachable, which is the user's report
  /// — "I can't even scroll on that edit view so I don't even know what it is."
  /// Draft bodies here run to 14,279 characters, i.e. hundreds of lines. A
  /// TextEditor in a fixed frame scrolls, so every line is reachable.
  ///
  /// The fixed height is also what keeps the panel honest: the field no longer
  /// changes size as the body grows, so a long draft cannot push Save off the
  /// bottom of a manually-sized 320pt popover.
  @ViewBuilder private func editorField(_ item: BriefItem) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      TextEditor(text: $editor.text)
        .font(.system(size: 11))
        .scrollContentBackground(.hidden)
        .padding(4)
        .frame(height: 120)
        .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
        .focused($editorFocused)
      HStack(spacing: 6) {
        Button("Save") { submitEdit(item) }
          .buttonStyle(.borderless).font(.system(size: 11)).foregroundStyle(.blue)
          // ⌘↩ saves. TextEditor has no .onSubmit — Return types a newline, as
          // it must in a multi-line body — so the shortcut moved to the modifier
          // that means "commit this" everywhere else on the platform. This
          // replaces the old ↩-saves/⌥↩-newline pairing, which taxed the common
          // keystroke in a multi-line field to serve the rare one.
          .keyboardShortcut(.return, modifiers: .command)
          // An all-whitespace body is a deletion wearing an edit's clothes:
          // draft-store.edit() writes whatever it is given, so refuse it here.
          .disabled(brief.inFlight.contains(item.id) || isBlank(editor.text))
        Button("Cancel") { editor.close() }
          .buttonStyle(.borderless).font(.system(size: 11)).foregroundStyle(.secondary)
          .disabled(brief.inFlight.contains(item.id))
        Spacer()
        Text("⌘↩ save · esc cancel").font(.system(size: 9)).foregroundStyle(.tertiary)
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
    // Deliberately NOT red. It shares a row with Discard, and two red buttons
    // one tap apart is the exact confusion this split exists to remove — the
    // weight lives in position and size (see deliberateButton), not in colour.
    // Present for the case where a retire-styled action is rendered by the
    // ordinary path (an older layout, a preview) rather than the quiet one.
    case "retire": return .secondary
    default: return .secondary
    }
  }
}
