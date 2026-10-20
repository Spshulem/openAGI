import SwiftUI

// Pieces shared by the Supervisor tab's question cards and its opened
// Watching rows. Like the rest of the tab, nothing here keeps height-changing
// state of its own: what is open, loading or in flight lives on FleetConsumer,
// which OverlayView watches to resize the panel.

/// Where a chat is ("remote-dev · Remote dev setup (Conductor)") and the
/// button that opens it. With no link, the button brings the app forward and
/// the note says why it can't land in the chat; a Claude Code terminal
/// session has no button, only its folder and the note.
struct FleetOpenChatLine: View {
  @ObservedObject var fleet = FleetConsumer.shared
  let chat: FleetOpenChat
  var prefix = "In"

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("\(prefix) \(chat.label)")
          .font(.system(size: 10)).foregroundStyle(.secondary)
          .lineLimit(2)
          .help(chat.label)
        Spacer(minLength: 4)
        if let title = FleetChatOpener.buttonTitle(chat) {
          Button(title) { fleet.openChat(chat) }
            .buttonStyle(.borderless).font(.system(size: 10))
            .fixedSize()
            .help(chat.link == nil ? (chat.note ?? "Bring \(chat.appName ?? "the app") to the front") : "Open this exact chat")
        }
      }
      if chat.link == nil, let note = chat.note, !note.isEmpty {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
      }
    }
  }
}

/// A question's words and its answers: the full text first when the ask is
/// risky (a release, deploy, delete or merge), then the options, Dismiss,
/// and the last result. Used inside an opened "Waiting on you" row.
struct FleetQuestionAnswer: View {
  @ObservedObject var fleet = FleetConsumer.shared
  @ObservedObject var app = AppState.shared
  let question: FleetQuestion

  private var busy: Bool { fleet.inFlight.contains(question.id) || fleet.stillSending.contains(question.id) }
  private var offline: Bool { app.status == .down }

  var body: some View {
    let options = question.tappableOptions
    VStack(alignment: .leading, spacing: 4) {
      if question.risky { FleetRiskyLabel() }
      Text(question.title)
        .font(.system(size: 11, weight: .semibold))
        .lineLimit(question.risky ? nil : 3)
        .fixedSize(horizontal: false, vertical: true)
      if !question.body.isEmpty {
        Text(question.body).font(.system(size: 11)).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if question.risky, let context = question.displayAskContext {
        Text(context).font(.system(size: 11)).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let asked = FleetQuestionAnswer.askedLine(question) {
        Text(asked).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
      }
      if question.answersInThread {
        Text(options.isEmpty ? "Answer this in the agent's own app." : "Or answer in the agent's own app.")
          .font(.system(size: 10)).foregroundStyle(.secondary)
      }
      HStack(spacing: 6) {
        if !options.isEmpty {
          FleetOptionButtons(question: question, options: options)
            .disabled(busy || offline)
        }
        Button("Dismiss") { Task { await fleet.dismiss(question) } }
          .buttonStyle(.borderless).font(.system(size: 10))
          .disabled(busy || offline)
          .help("Close this question without answering")
        Spacer(minLength: 0)
        if busy { ProgressView().controlSize(.small) }
      }
      if let note = fleet.notes[question.id] {
        FleetNoteRow(note: note) { fleet.clearNote(question.id) }
      }
    }
  }

  /// "Asked 3h ago" from the agent's ask time.
  static func askedLine(_ question: FleetQuestion, now: Date = Date()) -> String? {
    guard let at = question.askedTime.flatMap(FleetWatching.parseDate) else { return nil }
    return "Asked \(FleetThreadSummary.ago(at, now: now))"
  }
}

/// The options as buttons, side by side when they fit, else stacked. Shows
/// a capitalized label; the daemon gets the option exactly as offered.
struct FleetOptionButtons: View {
  @ObservedObject var fleet = FleetConsumer.shared
  let question: FleetQuestion
  let options: [String]

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 6) { buttons }
      VStack(alignment: .leading, spacing: 4) { buttons }
    }
  }

  @ViewBuilder private var buttons: some View {
    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
      let button = Button { Task { await fleet.answer(question, option: option) } } label: {
        Text(question.label(for: option)).lineLimit(1)
      }
      .controlSize(.small)
      if index == 0 && !question.risky {
        button.buttonStyle(.borderedProminent)
      } else {
        button.buttonStyle(.bordered)
      }
    }
  }
}

struct FleetRiskyLabel: View {
  var body: some View {
    Label("Read it all before answering", systemImage: "exclamationmark.triangle.fill")
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(.orange)
  }
}

/// One action's result, with a control that only hides it.
struct FleetNoteRow: View {
  let note: FleetNote
  let onHide: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 6) {
      Text(note.text).font(.system(size: 10))
        .foregroundStyle(note.isError ? Color.red : Color.secondary)
        .lineLimit(3)
      Spacer(minLength: 4)
      Button(action: onHide) {
        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
      }
      .buttonStyle(.plain)
      .help("Hide")
    }
  }
}

/// A thread's context: the agent's last words, its PR, what it waits on and
/// since when, the supervisor's next step and why.
struct FleetThreadLines: View {
  let summary: FleetThreadSummary
  var showsExcerpt = true

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if showsExcerpt, let excerpt = summary.excerpt {
        Text(summary.excerptAge.map { "Agent, \($0):" } ?? "Agent:")
          .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        Text(excerpt)
          .font(.system(size: 11))
          .lineLimit(10)
          .textSelection(.enabled)
          .help(excerpt)
      }
      if let pr = summary.prLine {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text("PR \(pr)").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
          Spacer(minLength: 4)
          if let link = summary.prLink {
            Button("Open PR") { NSWorkspace.shared.open(link) }
              .buttonStyle(.borderless).font(.system(size: 10)).fixedSize()
          }
        }
      }
      ForEach([summary.waitLine, summary.ownerLine, summary.mutedLine].compactMap { $0 }, id: \.self) { line in
        Text(line).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
      }
      if let next = summary.nextLine {
        Text(next).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(4)
      }
    }
  }
}
