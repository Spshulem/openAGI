import SwiftUI

struct OverlayView: View {
  @ObservedObject var state = OverlayState.shared
  @ObservedObject var app = AppState.shared
  var onCollapse: () -> Void = {}

  var body: some View {
    if state.expanded {
      expandedPanel
    } else {
      pill
    }
  }

  private var pill: some View {
    Button(action: { state.expanded = true }) {
      ZStack {
        Circle().fill(Color.accentColor).frame(width: 16, height: 16)
        if !app.nudges.isEmpty {
          Text("\(app.nudges.count)")
            .font(.system(size: 9, weight: .bold)).foregroundColor(.white)
        }
      }
      .padding(8)
    }
    .buttonStyle(.plain)
    .background(.ultraThinMaterial, in: Circle())
  }

  private var expandedPanel: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Ask OpenAGI").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button(action: { state.expanded = false; onCollapse() }) {
          Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
        }.buttonStyle(.plain)
      }
      if app.status == .down {
        Text("OpenAGI is offline").font(.caption).foregroundStyle(.red)
      }
      TextField("Ask about what you're looking at…", text: $state.question)
        .textFieldStyle(.roundedBorder)
        .disabled(app.status == .down)
        .onSubmit { Task { await state.ask() } }
      if let note = state.contextNote {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary)
      }
      if state.isLoading {
        ProgressView().controlSize(.small)
      } else if let err = state.error {
        Text(err).font(.caption).foregroundStyle(.red)
      } else if !state.answer.isEmpty {
        ScrollView { Text(state.answer).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
          .frame(maxHeight: 220)
        Button("Continue in chat") { app.openDashboard(path: "/?tab=chat") }
          .font(.caption).buttonStyle(.plain).foregroundStyle(.blue)
      }
    }
    .padding(12)
    .frame(width: 320)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
  }
}
