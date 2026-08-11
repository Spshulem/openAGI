import Foundation
import SwiftUI

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
    let requestId = AppState.shared.beginOverlayAsk()
    let ctx = await ScreenCapturer.shared.captureFocusedText(excludingWindowNumber: OverlayController.shared.panelWindowNumber)
    if let selected = briefContext {
      contextNote = "about \(selected.title)"
    } else if let ctx, !ctx.text.isEmpty {
      contextNote = "reading \(ctx.app)"
    } else {
      contextNote = "no screen context"
    }
    do {
      answer = try await AppState.shared.askOverlay(
        text: q,
        screenContext: ctx,
        briefContext: briefContext,
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
