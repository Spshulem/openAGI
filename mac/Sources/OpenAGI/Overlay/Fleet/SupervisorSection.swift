import SwiftUI

/// The Supervisor tab: the coding-agent supervisor's open questions, answered
/// in place with the options the supervisor offers.
///
/// Every piece of state that changes this view's height lives on
/// FleetConsumer or OverlayState, never in private @State: the panel is sized
/// from OverlayView's .onChange allowlist, and private state is invisible to it.
struct SupervisorSection: View {
  @ObservedObject var fleet = FleetConsumer.shared
  @ObservedObject var overlay = OverlayState.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text("SUPERVISOR").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        if fleet.isLoading { ProgressView().controlSize(.small) }
        Spacer()
        Button(fleet.scanning ? "Scanning…" : "Scan now") {
          Task { await fleet.scan() }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 10))
        .disabled(fleet.scanning || fleet.status?.running == true)
        .help("Check every coding agent now, and recheck each open question")
      }

      // One line, so the minute ticking over never changes the panel's height.
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Text(fleet.status.map { FleetConsumer.statusLine($0, count: fleet.questions.count, now: context.date) }
             ?? "Not loaded yet")
          .font(.system(size: 10)).foregroundStyle(.tertiary)
          .lineLimit(1)
      }

      if let scanError = fleet.status?.lastError, !scanError.isEmpty {
        Text("Last scan failed: \(scanError)")
          .font(.system(size: 10)).foregroundStyle(.red).lineLimit(2)
      }

      if let outcome = fleet.lastOutcome {
        statusRow(outcome, color: .green)
      }
      if let error = fleet.lastError {
        statusRow(error, color: .red)
      }

      if fleet.questions.isEmpty {
        Text("Nothing needs you.").font(.system(size: 11)).foregroundStyle(.tertiary)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 7) {
            ForEach(fleet.questions) { question in
              row(question)
            }
          }
        }
        .frame(maxHeight: 300)
      }
    }
  }

  private func statusRow(_ text: String, color: Color) -> some View {
    HStack(spacing: 6) {
      Text(text).font(.system(size: 11)).foregroundStyle(color).lineLimit(3)
      Spacer()
      Button("Dismiss") { fleet.clearOutcome() }
        .buttonStyle(.borderless).font(.system(size: 10))
    }
  }

  private func row(_ question: FleetQuestion) -> some View {
    let busy = fleet.inFlight.contains(question.id)
    let selected = overlay.fleetContext?.entityRef?.id == question.id
    return VStack(alignment: .leading, spacing: 4) {
      Button { overlay.chatAbout(question) } label: {
        Text(question.title)
          .font(.system(size: 12, weight: .semibold))
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("Chat with the supervisor about this question")
      if !question.body.isEmpty {
        Text(question.body).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
      }
      if let note = question.reviewNote {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
      }
      if question.kind == "agent-ask" {
        Text("Your answer goes to the agent.").font(.system(size: 10)).foregroundStyle(.secondary)
      }
      if !question.options.isEmpty {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { optionButtons(question) }
          VStack(alignment: .leading, spacing: 4) { optionButtons(question) }
        }
        .disabled(busy)
      }
      HStack(spacing: 8) {
        Button("Dismiss") { Task { await fleet.dismiss(question) } }
          .buttonStyle(.borderless).font(.system(size: 10))
          .disabled(busy)
          .help("Close this question without answering")
        Button { overlay.chatAbout(question) } label: {
          Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 10))
        }
        .buttonStyle(.borderless)
        .help("Chat with the supervisor about this question")
        Spacer()
        if busy { ProgressView().controlSize(.small) }
      }
    }
    .padding(8)
    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(selected ? 0.18 : 0.06)))
  }

  @ViewBuilder private func optionButtons(_ question: FleetQuestion) -> some View {
    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
      optionButton(question, option, prominent: index == 0)
    }
  }

  @ViewBuilder private func optionButton(_ question: FleetQuestion, _ option: String, prominent: Bool) -> some View {
    let button = Button { Task { await fleet.answer(question, option: option) } } label: {
      Text(option).lineLimit(1)
    }
    .controlSize(.small)
    if prominent {
      button.buttonStyle(.borderedProminent)
    } else {
      button.buttonStyle(.bordered)
    }
  }
}
