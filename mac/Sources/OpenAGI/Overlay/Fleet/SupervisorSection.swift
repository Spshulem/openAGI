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
      VoiceButton()
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

      if let item = fleet.openItem {
        FleetDetailScreen(item: item)
      } else {
        lists
      }
    }
  }

  @ViewBuilder private var lists: some View {
    Text("Needs you").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
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
      // Taller while a risky ask shows in full.
      .frame(maxHeight: fleet.questions.contains(where: \.risky) ? 420 : 300)
    }

    WatchingList()
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
    let selected = overlay.fleetContext?.entityRef?.id == question.id || overlay.voiceFocus.questionId == question.id
    let options = question.tappableOptions
    // A risky ask (release, deploy, delete, merge) is read in full before
    // any button.
    let full = question.risky
    let chat = question.openChat ?? question.chats.first
    return VStack(alignment: .leading, spacing: 4) {
      if question.risky { FleetRiskyLabel() }
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Button { fleet.openQuestion(question) } label: {
          HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(question.title)
              .font(.system(size: 12, weight: .semibold))
              .lineLimit(full ? nil : 3)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: full)
            Image(systemName: "chevron.right")
              .font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open: read the chat and reply")
        if let age = FleetConsumer.age(question.askedTime) {
          Text(age).font(.system(size: 10)).foregroundStyle(.tertiary).fixedSize()
            .help("Asked \(question.askedTime ?? "")")
        }
      }
      if let place = Self.placeLine(question) {
        Text(place).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
      }
      if !question.body.isEmpty {
        // The daemon caps the body at 220 characters: about five lines here.
        Text(question.body).font(.system(size: 11)).foregroundStyle(.secondary)
          .lineLimit(full ? nil : 6)
          .fixedSize(horizontal: false, vertical: full)
      }
      if question.risky, let context = question.displayAskContext {
        Text(context).font(.system(size: 11)).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let note = question.reviewNote {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
      }
      if question.kind == "agent-ask" && !options.isEmpty && !question.answersInThread {
        Text("Your answer goes to the agent.").font(.system(size: 10)).foregroundStyle(.secondary)
      }
      if question.answersInThread {
        // The supervisor can't carry this answer; it would only hand it back.
        let app = chat?.appName ?? "the agent's own app"
        Text(options.isEmpty ? "Answer this in \(app), then Scan now." : "Or answer in \(app), then Scan now.")
          .font(.system(size: 10)).foregroundStyle(options.isEmpty ? .secondary : .tertiary)
      }
      if !options.isEmpty {
        FleetOptionButtons(question: question, options: options)
          .disabled(busy || offline)
      }
      if let note = fleet.notes[question.id] {
        FleetNoteRow(note: note) { fleet.clearNote(question.id) }
      }
      HStack(spacing: 8) {
        if let chat, let title = FleetChatOpener.buttonTitle(chat) {
          // An answer only the agent's app takes: this is the main button.
          if question.answersInThread && options.isEmpty {
            Button(title) { fleet.openChat(chat) }
              .controlSize(.small).buttonStyle(.borderedProminent)
              .help(chat.link == nil ? (chat.note ?? chat.label) : "Open \(chat.label)")
          } else {
            Button(title) { fleet.openChat(chat) }
              .buttonStyle(.borderless).font(.system(size: 10))
              .help(chat.link == nil ? (chat.note ?? chat.label) : "Open \(chat.label)")
          }
        }
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

  /// "In remote-dev · Remote dev setup (Conductor) · asked 3h ago".
  static func placeLine(_ question: FleetQuestion, now: Date = Date()) -> String? {
    var parts: [String] = []
    if let label = question.chatLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
      parts.append("In \(label)")
    }
    if let at = question.askedTime.flatMap(FleetWatching.parseDate) {
      parts.append("asked \(FleetThreadSummary.ago(at, now: now))")
    }
    guard !parts.isEmpty else { return nil }
    let line = parts.joined(separator: " · ")
    return line.prefix(1).uppercased() + line.dropFirst()
  }

  /// The right-click twin of the row's Open chat, Chat and Dismiss, as on task rows.
  @ViewBuilder private func rowMenu(_ question: FleetQuestion, busy: Bool) -> some View {
    if let chat = question.openChat ?? question.chats.first, let title = FleetChatOpener.buttonTitle(chat) {
      Button(title) { fleet.openChat(chat) }
    }
    Button("Chat about this") { overlay.chatAbout(question) }
    Button("Dismiss") { Task { await fleet.dismiss(question) } }
      .disabled(busy || offline)
  }
}
