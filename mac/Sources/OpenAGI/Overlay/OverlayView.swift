import SwiftUI

struct OverlayView: View {
  @ObservedObject var state = OverlayState.shared
  @ObservedObject var app = AppState.shared
  @ObservedObject var outreach = OutreachConsumer.shared
  @ObservedObject var brief = BriefConsumer.shared
  @ObservedObject var briefEditor = BriefEditorState.shared
  @FocusState private var fieldFocused: Bool
  @State private var pillHovered = false
  // Per-item reply text for the targeted chat field, keyed by outreach id.
  @State private var replyText: [String: String] = [:]

  private func replyBinding(for id: String) -> Binding<String> {
    Binding(get: { replyText[id] ?? "" }, set: { replyText[id] = $0 })
  }
  var onCollapse: () -> Void = {}
  var onExpand: () -> Void = {}
  var onContentChange: () -> Void = {}

  // The resize watchers are applied in two chunks rather than one chain because
  // the whole thing — the Group's ViewBuilder plus fifteen generic .onChange
  // overloads — stopped type-checking in reasonable time as a single expression.
  // Splitting it is purely a compile-time concern; the modifier order, and so
  // the behaviour, is identical to writing them end to end.
  var body: some View {
    briefWatchers(panelWatchers(panelBody))
  }

  private var panelBody: some View {
    Group {
      if state.expanded {
        expandedPanel
          .transition(.asymmetric(
            insertion: .scale(scale: 0.96, anchor: .top).combined(with: .opacity),
            removal: .opacity
          ))
      } else {
        pill
          .transition(.scale(scale: 0.8).combined(with: .opacity))
      }
    }
    .animation(.spring(response: 0.28, dampingFraction: 0.85), value: state.expanded)
  }

  private func panelWatchers<V: View>(_ content: V) -> some View {
    content
    // `expanded` swaps a 44pt pill for a 320pt panel, which is the single
    // largest height change this view has. The two buttons below pair their
    // own mutation with onExpand/onCollapse, but they are not the only writers:
    // TrayController's "N needs you…" item and NotificationPresenter's
    // body/Review tap both do `OverlayController.show()` then set
    // `OverlayState.shared.expanded = true` directly. show() sizes the panel
    // FIRST — while `expanded` is still false, so to the pill's 44×44 — and
    // then the flag flips with nothing left to re-measure, leaving the whole
    // expanded panel rendering inside a pill-sized frame. Watching the state
    // itself covers every writer, including ones outside this file.
    .onChange(of: state.expanded) { _, _ in onContentChange() }
    // The panel resizes around this content — tell the controller whenever
    // something that changes our height lands (answer, error, nudges, …).
    .onChange(of: state.answer) { _, _ in onContentChange() }
    .onChange(of: state.isLoading) { _, _ in onContentChange() }
    .onChange(of: state.error) { _, _ in onContentChange() }
    .onChange(of: state.contextNote) { _, _ in onContentChange() }
    .onChange(of: app.status) { _, _ in onContentChange() }
    // Swaps the answer footer's button between "Continue in chat" and the
    // shorter "Open chat". Same single row at the default text size, but that
    // row is Button + Spacer + "Clear" inside a fixed 320pt panel, so at large
    // accessibility text sizes the longer label is what decides whether it
    // wraps to two lines. Height-relevant, therefore here.
    .onChange(of: app.lastAskSessionId) { _, _ in onContentChange() }
    // Same identity-not-count reasoning as `brief.items` below: OutreachConsumer
    // .ingest can drop an acted item and add a pending one in the same batch, so
    // the count holds while the rows — and the panel's height — change. Equatable.
    .onChange(of: outreach.items) { _, _ in onContentChange() }
  }

  private func briefWatchers<V: View>(_ content: V) -> some View {
    content
    // Every BriefConsumer field below adds or removes a row in BriefSection, and
    // the panel is sized manually — anything missing from this list renders clipped.
    // Watch `items`, not `items.count`: row height varies with content (title
    // wrap, whether `why` is present, whether the actions row renders), so a
    // same-count swap changes the panel's height too. BriefItem is Equatable.
    .onChange(of: brief.items) { _, _ in onContentChange() }
    .onChange(of: brief.isLoading) { _, _ in onContentChange() }
    .onChange(of: brief.lastError) { _, _ in onContentChange() }
    .onChange(of: brief.lastOutcome) { _, _ in onContentChange() }
    .onChange(of: brief.olderCount) { _, _ in onContentChange() }
    .onChange(of: brief.degraded) { _, _ in onContentChange() }
    .onChange(of: brief.inFlight) { _, _ in onContentChange() }
    // The inline draft editor is the one piece of brief state that is NOT on
    // BriefConsumer, and it changes the panel's height twice: once when it opens
    // (a multi-line field plus a button row appear inside a row) and again on
    // every line the body grows or shrinks by, since the field is 3–8 lines
    // tall. Both have to be here or the editor renders clipped — the failure
    // mode is losing the Save button off the bottom edge, mid-edit.
    .onChange(of: briefEditor.openItemID) { _, _ in onContentChange() }
    .onChange(of: briefEditor.text) { _, _ in onContentChange() }
    // The read-only body preview. Expanding a draft adds a 150pt scroll box, a
    // link row, AND lifts the row title's 2-line cap — three height changes on
    // one flag. Missing from this list it renders clipped, which is the exact
    // bug being fixed here ("I can't even scroll on that edit view"), so it has
    // to be watched from the moment the flag exists.
    .onChange(of: briefEditor.expandedItemID) { _, _ in onContentChange() }
  }

  // Combined attention count shown on the collapsed pill badge.
  private var pillBadgeCount: Int { brief.items.count + outreach.items.count }

  private var pill: some View {
    Button(action: {
      withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) { state.expanded = true }
      onExpand()
    }) {
      ZStack {
        Circle().fill(Color.accentColor).frame(width: 18, height: 18)
        if pillBadgeCount > 0 {
          Text("\(pillBadgeCount)")
            .font(.system(size: 9, weight: .bold)).foregroundColor(.white)
        }
      }
      .padding(9)
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .background(.ultraThinMaterial, in: Circle())
    .overlay(Circle().strokeBorder(.white.opacity(pillHovered ? 0.25 : 0.1), lineWidth: 1))
    .scaleEffect(pillHovered ? 1.08 : 1.0)
    .animation(.easeOut(duration: 0.12), value: pillHovered)
    .onHover { pillHovered = $0 }
    .help("Quick Ask (⌥Space)")
  }

  private var expandedPanel: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Ask OpenAGI").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button(action: {
          withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) { state.expanded = false }
          onCollapse()
        }) {
          Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .help("Collapse (Esc)")
      }
      if app.status == .down {
        Text("OpenAGI is offline").font(.caption).foregroundStyle(.red)
      }
      TextField("Ask about what you're looking at…", text: $state.question)
        .textFieldStyle(.roundedBorder)
        .focused($fieldFocused)
        .disabled(app.status == .down)
        .onSubmit { Task { await state.ask() } }
      if let note = state.contextNote {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary)
      }
      if state.isLoading {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Thinking…").font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
      } else if let err = state.error {
        Text(err).font(.caption).foregroundStyle(.red).lineLimit(4)
      } else if !state.answer.isEmpty {
        ScrollView {
          answerBody
        }
        .frame(maxHeight: 220)
        HStack {
          // Hands over the SESSION, not the text — see AppState.openChatSession.
          // Without an id (daemon answered 200 but named no session) the label
          // stops promising continuity it cannot deliver.
          Button(app.lastAskSessionId == nil ? "Open chat" : "Continue in chat") {
            app.openChatSession(app.lastAskSessionId)
          }
          .font(.caption).buttonStyle(.plain).foregroundStyle(.blue)
          .help(app.lastAskSessionId == nil
                ? "Open the dashboard's chat tab"
                : "Open this conversation in the dashboard, with the question, the answer and the screen context it used")
          Spacer()
          Button(action: { state.clearAnswer() }) {
            Text("Clear").font(.caption).foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
          .help("Clear the answer")
        }
      }
      if !outreach.items.isEmpty {
        Divider()
        Text("Needs you").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(outreach.items.prefix(6)) { item in
              outreachRow(item)
            }
          }
        }
        .frame(maxHeight: 240)
      }
      // Gate on everything BriefSection can render, not just the rows. Gating on
      // items alone hid the section the instant the last item was acted on —
      // which is exactly when "Task added" / "Skill created" lands, so the
      // confirmation for the final decision was never visible. It also hid a
      // failed refresh's error and the "N older" count on an empty brief.
      if brief.hasContent {
        Divider()
        BriefSection()
      }
    }
    .padding(12)
    .frame(width: 320)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.1), lineWidth: 1))
    .onAppear { fieldFocused = true; Task { await brief.refresh() } }
    .onChange(of: state.expanded) { _, expanded in if expanded { fieldFocused = true } }
  }

  // The agent answers in markdown ("## Open old tasks to triage", "**19 old
  // open/stale tasks**") and a plain Text renders that verbatim, so the popover
  // was showing the user the syntax instead of the answer. Blocks become real
  // layout; everything inline goes through AttributedString(markdown:).
  private var answerBody: some View {
    VStack(alignment: .leading, spacing: 5) {
      ForEach(QuickMarkdown.parse(state.answer)) { block in
        blockView(block)
      }
    }
    .textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private func blockView(_ block: QuickMarkdown.Block) -> some View {
    switch block.kind {
    case .heading(let level):
      Text(QuickMarkdown.inline(block.text))
        .font(.system(size: level <= 1 ? 14 : level == 2 ? 13 : 12, weight: .semibold))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    case .paragraph:
      Text(QuickMarkdown.inline(block.text))
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .quote:
      Text(QuickMarkdown.inline(block.text))
        .font(.callout).italic().foregroundStyle(.secondary)
        .padding(.leading, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .bullet(let marker):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(marker)
          .font(.callout).foregroundStyle(.secondary)
        Text(QuickMarkdown.inline(block.text))
          .font(.callout)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    case .code:
      Text(block.text)
        .font(.system(size: 11, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.12)))
    case .rule:
      Divider()
    }
  }

  // One proactive-outreach item: title, summary, its inline action buttons, and
  // a targeted reply field that routes a freeform message to /outreach/:id/reply.
  @ViewBuilder private func outreachRow(_ item: OutreachItem) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(item.title).font(.system(size: 12, weight: .semibold)).lineLimit(2)
      if !item.summary.isEmpty {
        Text(item.summary).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
      }
      if !item.actions.isEmpty {
        HStack(spacing: 6) {
          // "review" only opens the overlay list — pointless here since the user
          // is already looking at it (and the server no-ops it into 'acted'). Only
          // digests carry "review", so filtering it is safe.
          ForEach(item.actions.filter { $0 != "review" }, id: \.self) { a in
            Button(actionLabel(a)) {
              Task { await outreach.act(item.id, action: a) }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11))
          }
        }
      }
      HStack(spacing: 6) {
        TextField("Reply…", text: replyBinding(for: item.id))
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 11))
          .onSubmit { sendReply(item.id) }
        Button("Send") { sendReply(item.id) }
          .buttonStyle(.borderless)
          .font(.system(size: 11))
          .disabled((replyText[item.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
  }

  private func sendReply(_ id: String) {
    let text = (replyText[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    replyText[id] = ""
    Task { await outreach.reply(id, text: text) }
  }

  // "in_progress" → "In Progress"; default capitalizes the action verb.
  private func actionLabel(_ a: String) -> String {
    a.split(separator: "_").map { $0.capitalized }.joined(separator: " ")
  }
}

/// Just enough markdown for a 320pt popover — not a document viewer.
///
/// SwiftUI's `AttributedString(markdown:)` alone is not enough: it parses the
/// whole document but SwiftUI's `Text` ignores the block-level presentation
/// intents it produces, so "## Heading" and "- item" come out looking exactly
/// like the raw source the user was complaining about. So block syntax is
/// turned into layout here and only the inline span of each block is handed to
/// the system parser, which is genuinely good at **bold**, *italic*, `code`
/// and [links](https://example.com).
///
/// Consciously out of scope: nested/indented lists (flattened to one level),
/// tables (left as literal text), images, and footnotes. If the answer needs
/// those, "Continue in chat" is one click away and the dashboard renders full
/// markdown.
enum QuickMarkdown {
  struct Block: Identifiable {
    enum Kind {
      case heading(Int)
      case paragraph
      case quote
      case bullet(String)
      case code
      case rule
    }
    let id: Int
    let kind: Kind
    let text: String
  }

  static func parse(_ markdown: String) -> [Block] {
    var blocks: [Block] = []
    var paragraph: [String] = []
    var code: [String] = []
    var inCode = false

    func flushParagraph() {
      guard !paragraph.isEmpty else { return }
      blocks.append(Block(id: blocks.count, kind: .paragraph, text: paragraph.joined(separator: " ")))
      paragraph.removeAll()
    }
    func append(_ kind: Block.Kind, _ text: String) {
      flushParagraph()
      blocks.append(Block(id: blocks.count, kind: kind, text: text))
    }

    for raw in markdown.components(separatedBy: .newlines) {
      let line = raw.trimmingCharacters(in: .whitespaces)

      if line.hasPrefix("```") || line.hasPrefix("~~~") {
        if inCode {
          append(.code, code.joined(separator: "\n"))
          code.removeAll()
        } else {
          flushParagraph()
        }
        inCode.toggle()
        continue
      }
      if inCode { code.append(raw); continue }

      if line.isEmpty { flushParagraph(); continue }

      // A run of 3+ of -, * or _ and nothing else. Checked before the bullet
      // rule, which would otherwise eat "---" as a bullet with empty text.
      if line.count >= 3, line.allSatisfy({ $0 == "-" }) || line.allSatisfy({ $0 == "*" }) || line.allSatisfy({ $0 == "_" }) {
        append(.rule, "")
        continue
      }
      if let heading = headingSplit(line) {
        append(.heading(heading.level), heading.text)
        continue
      }
      if line.hasPrefix("> ") || line == ">" {
        append(.quote, String(line.dropFirst(1)).trimmingCharacters(in: .whitespaces))
        continue
      }
      if let bullet = bulletSplit(line) {
        append(.bullet(bullet.marker), bullet.text)
        continue
      }
      paragraph.append(line)
    }
    // An unterminated fence still has to render — truncated model output is
    // common enough that dropping the tail would lose the answer.
    if inCode, !code.isEmpty { append(.code, code.joined(separator: "\n")) }
    flushParagraph()
    return blocks
  }

  /// "### Foo" → (3, "Foo"). Requires the space, so a "#hashtag" stays text.
  private static func headingSplit(_ line: String) -> (level: Int, text: String)? {
    var level = 0
    var rest = Substring(line)
    while rest.first == "#", level < 6 {
      level += 1
      rest = rest.dropFirst()
    }
    guard level > 0, rest.first == " " else { return nil }
    // Trailing "##" (closed ATX headings) is decoration, not content.
    let text = rest.trimmingCharacters(in: .whitespaces)
      .replacingOccurrences(of: "#+$", with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    return (level, text)
  }

  /// "- foo" / "* foo" / "3. foo" → the marker to draw plus the item text.
  /// Ordered items keep their own number so a numbered list stays numbered.
  private static func bulletSplit(_ line: String) -> (marker: String, text: String)? {
    for lead in ["- ", "* ", "+ "] where line.hasPrefix(lead) {
      return ("•", String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces))
    }
    let digits = line.prefix { $0.isNumber }
    if !digits.isEmpty, digits.count <= 3 {
      let after = line.dropFirst(digits.count)
      if after.hasPrefix(". ") || after.hasPrefix(") ") {
        return (digits + ".", String(after.dropFirst(2)).trimmingCharacters(in: .whitespaces))
      }
    }
    return nil
  }

  /// Inline emphasis, code spans and links for one block's text.
  /// `.inlineOnlyPreservingWhitespace` is deliberate: block syntax has already
  /// been consumed above, and the full parser would re-flow whitespace and
  /// re-introduce presentation intents that `Text` cannot draw. On a parse
  /// failure the raw string is shown — never nothing.
  static func inline(_ s: String) -> AttributedString {
    guard !s.isEmpty else { return AttributedString("") }
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible
    )
    return (try? AttributedString(markdown: s, options: options)) ?? AttributedString(s)
  }
}
