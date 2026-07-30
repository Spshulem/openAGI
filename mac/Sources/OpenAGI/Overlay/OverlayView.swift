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

  var body: some View {
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
    // The panel resizes around this content — tell the controller whenever
    // something that changes our height lands (answer, error, nudges, …).
    .onChange(of: state.answer) { _, _ in onContentChange() }
    .onChange(of: state.isLoading) { _, _ in onContentChange() }
    .onChange(of: state.error) { _, _ in onContentChange() }
    .onChange(of: state.contextNote) { _, _ in onContentChange() }
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
    // Same identity-not-count reasoning as `brief.items`: OutreachConsumer.ingest
    // can drop an acted item and add a pending one in the same batch, so the
    // count holds while the rows — and the panel's height — change. Equatable.
    .onChange(of: outreach.items) { _, _ in onContentChange() }
    .onChange(of: app.status) { _, _ in onContentChange() }
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
          Text(state.answer)
            .font(.callout)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
        HStack {
          Button("Continue in chat") { app.openDashboard(path: "/?tab=chat") }
            .font(.caption).buttonStyle(.plain).foregroundStyle(.blue)
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
