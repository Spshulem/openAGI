import Foundation
import SwiftUI

/// Which list the Ask OpenAGI panel shows under the ask field. The ask field
/// follows it: Tasks asks about the screen and brief rows, Supervisor asks the
/// coding-agent supervisor in its own session.
enum OverlayTab: Equatable {
  case tasks, supervisor
}

@MainActor
final class OverlayState: ObservableObject {
  static let shared = OverlayState()

  @Published var expanded = false {
    didSet { if !expanded { voiceSession.stop() } }
  }
  private let voiceSession: VoiceSession
  private let isEnabled: @MainActor () -> Bool
  @Published var question = ""
  @Published var answer: String = ""
  @Published var isLoading = false
  @Published var progressStage: String? = nil
  @Published var isDetached = false
  /// What the "connection lost" banner says while the overlay finds out on
  /// its own how a dropped ask ended. Changes the banner's height.
  @Published private(set) var detachedPhase: DetachedPhase = .none
  @Published var error: String? = nil
  @Published var contextNote: String? = nil
  @Published private(set) var briefContext: BriefChatContext? = nil
  @Published private(set) var tab: OverlayTab = .tasks
  /// The supervisor question the Supervisor tab's ask field is about; nil
  /// means the supervisor as a whole.
  @Published private(set) var fleetContext: BriefChatContext? = nil
  /// Counter rather than Bool so selecting the same row twice still focuses.
  @Published private(set) var composerFocusRequest: UInt = 0
  @Published private(set) var voiceFocus = VoiceFocus()

  init(voiceSession: VoiceSession? = nil,
       isEnabled: @escaping @MainActor () -> Bool = { OverlayController.isEnabled }) {
    self.voiceSession = voiceSession ?? .shared
    self.isEnabled = isEnabled
  }

  func beginVoice(_ source: VoicePTT.Source) {
    guard isEnabled() else { return }
    guard !isLoading, !isDetached else {
      error = "Wait for the current question to finish before starting voice."
      return
    }
    selectTab(.supervisor)
    expanded = true
    OverlayController.shared.show()
    voiceSession.press(source, focus: voiceFocus)
  }

  func selectVoiceContext(_ focus: VoiceFocus) {
    voiceFocus = focus
    voiceSession.updateFocus(focus)
  }

  func pruneVoiceContext(openIDs: Set<String>, threadKeys: Set<String>) {
    if let id = voiceFocus.questionId, !openIDs.contains(id) {
      selectVoiceContext(VoiceFocus())
    } else if let key = voiceFocus.threadKey, !threadKeys.contains(key), voiceFocus.questionId == nil {
      selectVoiceContext(VoiceFocus())
    }
  }

  enum DetachedPhase: Equatable {
    case none
    /// Reading the session back once to see whether the reply landed.
    case checking
    /// Not finished yet: the answer will be in the main app. Clears itself.
    case stillRunning
  }

  /// The one read-back after a dropped stream, then the banner's own clear.
  private var detachedRecovery: Task<Void, Never>?
  static let detachedCheckDelay: TimeInterval = 4
  static let detachedClearDelay: TimeInterval = 12

  func chatAbout(_ item: BriefItem) {
    briefContext = BriefChatContext(item: item)
    answer = ""
    error = nil
    endDetached()
    contextNote = nil
    composerFocusRequest &+= 1
  }

  func addRelatedTask(to item: BriefItem) {
    chatAbout(item)
    question = "Add a related task: "
  }

  func clearBriefContext() {
    briefContext = nil
    composerFocusRequest &+= 1
  }

  /// The chip and the ask follow the visible tab.
  var activeContext: BriefChatContext? {
    tab == .supervisor ? fleetContext : briefContext
  }

  /// Switch lists. An answer on screen belongs to the other tab's session, so
  /// it goes, unless it is still streaming. The typed question stays.
  func selectTab(_ newTab: OverlayTab) {
    // An answer still streaming belongs to the tab that asked; switching
    // mid-request would show it under the other tab.
    guard tab != newTab, !isLoading, !isDetached else { return }
    tab = newTab
    if newTab == .tasks {
      voiceSession.stop()
      FleetConsumer.shared.supervisorTabLeft()
    }
    answer = ""
    error = nil
    contextNote = nil
    progressStage = nil
  }

  func chatAbout(_ question: FleetQuestion) {
    tab = .supervisor
    fleetContext = BriefChatContext(question: question)
    selectVoiceContext(.question(question))
    answer = ""
    error = nil
    endDetached()
    contextNote = nil
    composerFocusRequest &+= 1
  }

  func clearActiveContext() {
    if tab == .supervisor {
      fleetContext = nil
      selectVoiceContext(VoiceFocus())
    } else { briefContext = nil }
    composerFocusRequest &+= 1
  }

  /// A question that closed (answered anywhere, dismissed, reviewed away) can
  /// no longer be the ask's subject.
  func pruneFleetContext(openIDs: Set<String>) {
    guard let id = fleetContext?.entityRef?.id, !openIDs.contains(id) else { return }
    fleetContext = nil
  }

  /// Reset the answer area so the panel shrinks back to just the ask field.
  func clearAnswer() {
    answer = ""
    error = nil
    contextNote = nil
    question = ""
    progressStage = nil
    endDetached()
  }

  private func endDetached() {
    detachedRecovery?.cancel()
    detachedRecovery = nil
    isDetached = false
    detachedPhase = .none
  }

  /// The stream dropped, but the daemon may still finish the turn. Read the
  /// session back once, after a short wait: a saved reply replaces the
  /// banner; otherwise it says the answer will be in the main app and goes
  /// away on its own. Never re-sends the ask.
  private func recoverDetached(sessionId: String, requestId: String) {
    detachedRecovery?.cancel()
    detachedPhase = .checking
    detachedRecovery = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(OverlayState.detachedCheckDelay * 1_000_000_000))
      guard let self, !Task.isCancelled, self.isDetached else { return }
      let found = await AppState.shared.overlayReply(sessionId: sessionId, requestId: requestId)
      guard !Task.isCancelled, self.isDetached else { return }
      switch found {
      case let .answered(text):
        self.answer = text
        self.progressStage = nil
        self.endDetached()
      case let .failed(text):
        self.error = text
        self.progressStage = nil
        self.endDetached()
      case nil:
        self.detachedPhase = .stillRunning
        try? await Task.sleep(nanoseconds: UInt64(OverlayState.detachedClearDelay * 1_000_000_000))
        guard !Task.isCancelled, self.isDetached else { return }
        if !self.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          self.error = "Response interrupted. This is a partial answer; check the saved conversation in the main app."
        }
        self.progressStage = nil
        self.endDetached()
      }
    }
  }

  func ask() async {
    let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty, !isLoading, !isDetached else { return }
    endDetached()
    isLoading = true; error = nil; answer = ""; progressStage = "queued"
    let supervisor = tab == .supervisor
    let sessionId = supervisor ? AppState.overlaySupervisorSessionId : AppState.overlayTasksSessionId
    let requestId = AppState.shared.beginOverlayAsk(sessionId: sessionId)
    let ctx: ScreenContext?
    let chatContext: BriefChatContext?
    if supervisor {
      // The supervisor chat is about coding agents, not the screen: no capture.
      ctx = nil
      chatContext = fleetContext ?? .fleetOverview
      contextNote = fleetContext.map { "about \($0.title)" } ?? "about the supervisor"
    } else {
      ctx = await ScreenCapturer.shared.captureFocusedText(excludingWindowNumber: OverlayController.shared.panelWindowNumber)
      chatContext = briefContext
      if let selected = briefContext {
        contextNote = "about \(selected.title)"
      } else if let ctx, !ctx.text.isEmpty {
        contextNote = "reading \(ctx.app)"
      } else {
        contextNote = "no screen context"
      }
    }
    do {
      answer = try await AppState.shared.askOverlay(
        text: q,
        screenContext: ctx,
        briefContext: chatContext,
        sessionId: sessionId,
        requestId: requestId,
        onProgress: { [weak self] stage in self?.progressStage = stage },
        onTextDelta: { [weak self] text, reset in
          guard let self else { return }
          self.answer = reset ? text : self.answer + text
        }
      )
    } catch {
      if AppState.requestMayStillBeRunning(after: error) {
        isDetached = true
        progressStage = "disconnected"
        recoverDetached(sessionId: AppState.shared.lastAskSessionId ?? sessionId, requestId: requestId)
      } else {
        self.error = error.localizedDescription
      }
    }
    isLoading = false
  }

  var progressLabel: String {
    switch progressStage {
    case "queued": return "Queued…"
    case "routing": return "Choosing the right agent…"
    case "accepted": return "Request saved…"
    case "context": return "Gathering context…"
    case "reasoning", "model": return "Thinking…"
    case "tool": return "Using tools…"
    case "saving": return "Saving the answer…"
    case "disconnected": return "Connection lost…"
    default: return "Working…"
    }
  }
}
