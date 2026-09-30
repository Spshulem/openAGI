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

  @Published var expanded = false
  @Published var question = ""
  @Published var answer: String = ""
  @Published var isLoading = false
  @Published var progressStage: String? = nil
  @Published var isDetached = false
  @Published var error: String? = nil
  @Published var contextNote: String? = nil
  @Published private(set) var briefContext: BriefChatContext? = nil
  @Published private(set) var tab: OverlayTab = .tasks
  /// The supervisor question the Supervisor tab's ask field is about; nil
  /// means the supervisor as a whole.
  @Published private(set) var fleetContext: BriefChatContext? = nil
  /// Counter rather than Bool so selecting the same row twice still focuses.
  @Published private(set) var composerFocusRequest: UInt = 0

  func chatAbout(_ item: BriefItem) {
    briefContext = BriefChatContext(item: item)
    answer = ""
    error = nil
    isDetached = false
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
    guard tab != newTab else { return }
    tab = newTab
    guard !isLoading, !isDetached else { return }
    answer = ""
    error = nil
    contextNote = nil
    progressStage = nil
  }

  func chatAbout(_ question: FleetQuestion) {
    tab = .supervisor
    fleetContext = BriefChatContext(question: question)
    answer = ""
    error = nil
    isDetached = false
    contextNote = nil
    composerFocusRequest &+= 1
  }

  func clearActiveContext() {
    if tab == .supervisor { fleetContext = nil } else { briefContext = nil }
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
    isDetached = false
  }

  func ask() async {
    let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty, !isLoading, !isDetached else { return }
    isLoading = true; error = nil; isDetached = false; answer = ""; progressStage = "queued"
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
