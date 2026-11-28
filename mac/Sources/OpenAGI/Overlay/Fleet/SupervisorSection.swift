import SwiftUI

/// Compact Supervisor surface for the 320pt Quick Ask floater:
/// 1-line live status + mic/scan controls, a single focused Decision Card
/// pager (`‹ 1/N ›`), and a collapsible sessions drawer (`WatchingList`).
///
/// Height-changing state lives on `FleetConsumer` / `VoiceSession` /
/// `OverlayState` so `OverlayView` resizes the manually-sized NSPanel cleanly.
struct SupervisorSection: View {
  @ObservedObject var fleet = FleetConsumer.shared
  @ObservedObject var overlay = OverlayState.shared
  @ObservedObject var app = AppState.shared
  @ObservedObject var voice = VoiceSession.shared

  private var offline: Bool { app.status == .down }
  private var scanRunning: Bool { fleet.scanning || fleet.status?.running == true }

  private var runningCount: Int {
    fleet.threads.filter { ($0.state ?? "").lowercased() == "running" }.count
  }

  private var activeSummaryText: String {
    if fleet.threads.isEmpty {
      return scanRunning ? "Scanning sessions…" : "No active chats"
    }
    var parts: [String] = []
    if runningCount > 0 { parts.append("\(runningCount) working") }
    parts.append("\(fleet.threads.count) watched")
    return parts.joined(separator: " · ")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      compactStatusBar

      if voice.active || !voice.transcript.isEmpty || !voice.reply.isEmpty || voice.error != nil || voice.notice != nil {
        voiceTranscriptBox
      }

      if let scanError = fleet.status?.lastError, !scanError.isEmpty {
        Text("Last scan failed: \(scanError)")
          .font(.system(size: 10))
          .foregroundStyle(WorkspaceTheme.alert)
          .lineLimit(2)
      }

      if let outcome = fleet.lastOutcome {
        statusRow(outcome, color: WorkspaceTheme.live)
      }
      if let error = fleet.lastError {
        statusRow(error, color: WorkspaceTheme.alert)
      }

      if let item = fleet.openItem {
        FleetDetailScreen(item: item)
      } else {
        deckAndSessions
      }
    }
  }

  private var compactStatusBar: some View {
    HStack(spacing: 6) {
      Button {
        fleet.toggleWatchingExpanded()
      } label: {
        HStack(spacing: 5) {
          Circle()
            .fill(runningCount > 0 ? WorkspaceTheme.live : WorkspaceTheme.muted.opacity(0.6))
            .frame(width: 6, height: 6)
          Text(activeSummaryText)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(WorkspaceTheme.muted)
            .lineLimit(1)
          if !fleet.threads.isEmpty {
            Image(systemName: fleet.watchingExpanded ? "chevron.down" : "chevron.right")
              .font(.system(size: 8.5, weight: .semibold))
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(fleet.threads.isEmpty)
      .help(fleet.watchingExpanded ? "Hide active chats" : "Show active chats")

      if fleet.isLoading {
        ProgressView().controlSize(.mini)
      }

      Spacer(minLength: 4)

      Button {
        if voice.micHeld { voice.release(.mic) }
        else { overlay.beginVoice(.mic) }
      } label: {
        HStack(spacing: 3) {
          Image(systemName: voice.recording ? "stop.circle.fill" : "mic.fill")
            .font(.system(size: 10.5, weight: .semibold))
          if voice.active {
            Text(voiceStatusText)
              .font(.system(size: 10, weight: .medium))
          }
        }
        .foregroundStyle(voice.recording ? WorkspaceTheme.alert : WorkspaceTheme.muted)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
          (voice.recording ? WorkspaceTheme.alert : WorkspaceTheme.muted).opacity(0.12),
          in: Capsule()
        )
      }
      .buttonStyle(.plain)
      .disabled(voice.phase == .connecting)
      .help("Talk to Supervisor (⌥⇧Space)")
      .accessibilityLabel(voice.micHeld ? "Send to Supervisor" : "Talk with Supervisor")
      .accessibilityValue(voice.active ? voiceStatusText : "Microphone off")
      .accessibilityHint("Your words and the spoken replies are saved in the Supervisor chat.")

      if voice.active {
        Button("End") { voice.stop() }
          .buttonStyle(.borderless)
          .font(.system(size: 10))
          .foregroundStyle(WorkspaceTheme.muted)
          .accessibilityLabel("Stop voice")
          .accessibilityHint("Turns the microphone off and ends the voice session.")
      }

      Button {
        Task { await fleet.scan() }
      } label: {
        Group {
          if scanRunning {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 10.5, weight: .semibold))
              .foregroundStyle(WorkspaceTheme.muted)
          }
        }
        .frame(width: 22, height: 22)
      }
      .buttonStyle(.plain)
      .disabled(fleet.scanning || offline)
      .help("Scan coding agents now")
    }
  }

  private var voiceTranscriptBox: some View {
    VStack(alignment: .leading, spacing: 4) {
      if !voice.transcript.isEmpty {
        Text("You: \(voice.transcript)")
          .font(.system(size: 11))
          .lineLimit(4)
          .textSelection(.enabled)
      }
      if !voice.reply.isEmpty {
        Text(voice.reply)
          .font(.system(size: 11))
          .foregroundStyle(WorkspaceTheme.muted)
          .lineLimit(6)
          .textSelection(.enabled)
      }
      if let message = voice.error ?? voice.notice {
        Text(message)
          .font(.system(size: 10))
          .foregroundStyle(voice.error == nil ? WorkspaceTheme.muted : WorkspaceTheme.alert)
          .lineLimit(4)
      }
      if voice.error != nil {
        Text(VoiceSession.textFallbackNote)
          .font(.system(size: 10))
          .foregroundStyle(WorkspaceTheme.muted)
      }
    }
    .accessibilityElement(children: .combine)
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(WorkspaceTheme.surfaceFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private var voiceStatusText: String {
    switch voice.phase {
    case .idle: return "Voice"
    case .connecting: return "Connecting"
    case .ready: return "Ready"
    case .recording: return "Listening"
    case .waiting: return "Thinking"
    case .replying: return "Speaking"
    }
  }

  @ViewBuilder private var deckAndSessions: some View {
    if fleet.questions.isEmpty {
      HStack(spacing: 6) {
        Image(systemName: "checkmark.circle")
          .font(.system(size: 11))
          .foregroundStyle(WorkspaceTheme.live)
        Text("All clear — nothing waiting on you.")
          .font(.system(size: 11))
          .foregroundStyle(WorkspaceTheme.muted)
      }
      .padding(.vertical, 4)
    } else {
      let index = min(max(0, fleet.currentQuestionIndex), fleet.questions.count - 1)
      focusedCard(fleet.questions[index], index: index, total: fleet.questions.count)
    }

    if fleet.watchingExpanded {
      WatchingList()
    }
  }

  private func focusedCard(_ question: FleetQuestion, index: Int, total: Int) -> some View {
    let busy = fleet.inFlight.contains(question.id) || fleet.stillSending.contains(question.id)
    let options = question.tappableOptions
    let chat = question.openChat ?? question.chats.first

    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        if question.risky {
          FleetRiskyLabel()
        } else if let place = Self.placeLine(question) {
          Text(place)
            .font(.system(size: 10))
            .foregroundStyle(WorkspaceTheme.muted)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 4)
        if total > 1 {
          HStack(spacing: 3) {
            Button {
              fleet.stepQuestion(-1)
            } label: {
              Image(systemName: "chevron.left")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(WorkspaceTheme.muted)
                .frame(width: 16, height: 16)
            }
            .buttonStyle(.plain)

            Text("\(index + 1)/\(total)")
              .font(.system(size: 10, weight: .semibold).monospacedDigit())
              .foregroundStyle(WorkspaceTheme.muted)

            Button {
              fleet.stepQuestion(1)
            } label: {
              Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(WorkspaceTheme.muted)
                .frame(width: 16, height: 16)
            }
            .buttonStyle(.plain)
          }
        }
        Button {
          Task { await fleet.dismiss(question) }
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(WorkspaceTheme.muted)
            .frame(width: 16, height: 16)
        }
        .buttonStyle(.plain)
        .disabled(busy || offline)
        .help("Dismiss")
      }

      Button {
        fleet.openQuestion(question)
      } label: {
        Text(question.title)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(WorkspaceTheme.ink)
          .lineLimit(question.risky ? 4 : 2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("Open context and reply")

      if let decision = question.decisionPresentation(card: fleet.cardBriefs[question.id]) {
        // Goal, Status, Decision, Recommendation before any button.
        NeedsYouDecisionSections(presentation: decision, style: .compact)
      } else if !question.body.isEmpty {
        Button {
          fleet.openQuestion(question)
        } label: {
          Text(question.body)
            .font(.system(size: 11))
            .foregroundStyle(WorkspaceTheme.muted)
            .lineLimit(question.risky ? 6 : 3)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open context and reply")
      }

      if let note = fleet.notes[question.id] {
        FleetNoteRow(note: note) { fleet.clearNote(question.id) }
      }

      HStack(spacing: 6) {
        if !options.isEmpty {
          FleetOptionButtons(question: question, options: options)
            .disabled(busy || offline)
        }
        Spacer(minLength: 4)
        if busy {
          ProgressView().controlSize(.small)
        }
        Button {
          fleet.openQuestion(question)
        } label: {
          Text("Details ›")
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(WorkspaceTheme.live)
        }
        .buttonStyle(.plain)
        if let chat, FleetChatOpener.buttonTitle(chat) != nil {
          Button {
            fleet.openChat(chat)
          } label: {
            Image(systemName: "arrow.up.forward.app")
              .font(.system(size: 11))
              .foregroundStyle(WorkspaceTheme.muted)
          }
          .buttonStyle(.plain)
          .help(chat.link == nil ? (chat.note ?? chat.label) : "Open \(chat.label)")
        }
      }
    }
    .padding(10)
    .background(
      WorkspaceTheme.surfaceFill.opacity(0.75),
      in: RoundedRectangle(cornerRadius: 12, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(WorkspaceTheme.edge, lineWidth: 0.5)
    )
    .contextMenu { rowMenu(question, busy: busy) }
  }

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

  @ViewBuilder private func rowMenu(_ question: FleetQuestion, busy: Bool) -> some View {
    if let chat = question.openChat ?? question.chats.first, let title = FleetChatOpener.buttonTitle(chat) {
      Button(title) { fleet.openChat(chat) }
    }
    Button("Chat about this") { overlay.chatAbout(question) }
    Button("Dismiss") { Task { await fleet.dismiss(question) } }
      .disabled(busy || offline)
  }
}
