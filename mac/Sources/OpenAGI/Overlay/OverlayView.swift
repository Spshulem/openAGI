import SwiftUI

struct OverlayView: View {
  @ObservedObject var state = OverlayState.shared
  @ObservedObject var app = AppState.shared
  @FocusState private var fieldFocused: Bool
  @State private var pillHovered = false
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
    .onChange(of: app.nudges.count) { _, _ in onContentChange() }
    .onChange(of: app.status) { _, _ in onContentChange() }
  }

  private var pill: some View {
    Button(action: {
      withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) { state.expanded = true }
      onExpand()
    }) {
      ZStack {
        Circle().fill(Color.accentColor).frame(width: 18, height: 18)
        if !app.nudges.isEmpty {
          Text("\(app.nudges.count)")
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
      if !app.nudges.isEmpty {
        Divider()
        Text("Nudges").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        ForEach(app.nudges.prefix(4)) { n in
          HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
              Text(n.title).font(.system(size: 11, weight: .medium)).lineLimit(2)
              if !n.body.isEmpty { Text(n.body).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer()
            Button(action: { app.openDashboard(path: "/?tab=chat&suggestion=\(n.id)") }) {
              Image(systemName: "arrow.up.right.square")
            }.buttonStyle(.plain).help("Review in chat")
            Button(action: {
              withAnimation(.easeOut(duration: 0.15)) { app.nudges.removeAll { $0.id == n.id } }
            }) {
              Image(systemName: "xmark")
            }.buttonStyle(.plain).help("Dismiss")
          }
        }
      }
    }
    .padding(12)
    .frame(width: 320)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.1), lineWidth: 1))
    .onAppear { fieldFocused = true }
    .onChange(of: state.expanded) { _, expanded in if expanded { fieldFocused = true } }
  }
}
