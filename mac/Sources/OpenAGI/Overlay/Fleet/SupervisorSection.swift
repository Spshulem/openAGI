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
  @ObservedObject var app = AppState.shared

  /// Offline, every button here can only fail: grey them out instead.
  private var offline: Bool { app.status == .down }

  private var scanRunning: Bool { fleet.scanning || fleet.status?.running == true }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // One row: the tab already names the section and counts the questions.
      HStack(spacing: 6) {
        // One line, so the minute ticking over never changes the panel's height.
        TimelineView(.periodic(from: .now, by: 30)) { context in
          let line = fleet.status.map { FleetConsumer.statusLine($0, now: context.date) } ?? "Not loaded yet"
          Text(line)
            .font(.system(size: 10)).foregroundStyle(.tertiary)
            .lineLimit(1)
            .truncationMode(.tail)
            .help(line)
        }
        if fleet.isLoading { ProgressView().controlSize(.small) }
        Spacer(minLength: 4)
        // Only our own request disables it: a scheduled scan's `running` can
        // be stale, and the daemon queues an owner scan behind a running one.
        Button(scanRunning ? "Scanning…" : "Scan now") {
          Task { await fleet.scan() }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 10))
        .fixedSize()
        .disabled(fleet.scanning || offline)
        .help("Check every coding agent now, and recheck each open question")
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

  /// A panel-wide message. Its control only hides the message, so it is an
  /// icon, not a second "Dismiss" beside the rows' Dismiss that closes a question.
  private func statusRow(_ text: String, color: Color) -> some View {
    HStack(alignment: .top, spacing: 6) {
      Text(text).font(.system(size: 11)).foregroundStyle(color).lineLimit(3)
      Spacer(minLength: 4)
      Button { fleet.clearOutcome() } label: {
        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
      }
      .buttonStyle(.plain)
      .help("Hide")
    }
  }

  private func row(_ question: FleetQuestion) -> some View {
    let busy = fleet.inFlight.contains(question.id) || fleet.stillSending.contains(question.id)
    let selected = overlay.fleetContext?.entityRef?.id == question.id
    let options = question.tappableOptions
    return VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Button { overlay.chatAbout(question) } label: {
          Text(question.title)
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(3)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Chat with the supervisor about this question")
        if let age = FleetConsumer.age(question.createdAt) {
          Text(age).font(.system(size: 10)).foregroundStyle(.tertiary).fixedSize()
        }
      }
      if !question.body.isEmpty {
        // The daemon caps the body at 220 characters: about five lines here.
        Text(question.body).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(6)
      }
      if let note = question.reviewNote {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
      }
      if question.kind == "agent-ask" && !options.isEmpty {
        Text("Your answer goes to the agent.").font(.system(size: 10)).foregroundStyle(.secondary)
      }
      if question.answersInThread && options.isEmpty {
        // The supervisor can't carry this answer; it would only hand it back.
        Text("Answer this in the agent's own app, then Scan now.")
          .font(.system(size: 10)).foregroundStyle(.secondary)
      } else if question.answersInThread {
        // Tap a choice here, or type something else in the agent's own app.
        Text("Or answer in the agent's own app.")
          .font(.system(size: 10)).foregroundStyle(.tertiary)
      }
      if !options.isEmpty {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { optionButtons(question, options) }
          VStack(alignment: .leading, spacing: 4) { optionButtons(question, options) }
        }
        .disabled(busy || offline)
      }
      if let note = fleet.notes[question.id] {
        HStack(alignment: .top, spacing: 6) {
          Text(note.text).font(.system(size: 10))
            .foregroundStyle(note.isError ? Color.red : Color.secondary)
            .lineLimit(3)
          Spacer(minLength: 4)
          Button { fleet.clearNote(question.id) } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
          }
          .buttonStyle(.plain)
          .help("Hide")
        }
      }
      HStack(spacing: 8) {
        Button("Chat") { overlay.chatAbout(question) }
          .buttonStyle(.borderless).font(.system(size: 10))
          .help("Chat with the supervisor about this question")
        Button("Dismiss") { Task { await fleet.dismiss(question) } }
          .buttonStyle(.borderless).font(.system(size: 10))
          .disabled(busy || offline)
          .help("Close this question without answering")
        Spacer()
        if busy { ProgressView().controlSize(.small) }
      }
    }
    .padding(8)
    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(selected ? 0.18 : 0.06)))
    .contentShape(Rectangle())
    .contextMenu { rowMenu(question, busy: busy) }
  }

  /// The right-click twin of the row's Chat and Dismiss, as on task rows.
  @ViewBuilder private func rowMenu(_ question: FleetQuestion, busy: Bool) -> some View {
    Button("Chat about this") { overlay.chatAbout(question) }
    Button("Dismiss") { Task { await fleet.dismiss(question) } }
      .disabled(busy || offline)
  }

  @ViewBuilder private func optionButtons(_ question: FleetQuestion, _ options: [String]) -> some View {
    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
      optionButton(question, option, prominent: index == 0)
    }
  }

  /// Shows a capitalized label; the daemon gets the option exactly as offered.
  @ViewBuilder private func optionButton(_ question: FleetQuestion, _ option: String, prominent: Bool) -> some View {
    let button = Button { Task { await fleet.answer(question, option: option) } } label: {
      Text(question.label(for: option)).lineLimit(1)
    }
    .controlSize(.small)
    if prominent {
      button.buttonStyle(.borderedProminent)
    } else {
      button.buttonStyle(.bordered)
    }
  }
}
