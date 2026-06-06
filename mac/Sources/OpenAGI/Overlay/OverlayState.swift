import Foundation
import SwiftUI

@MainActor
final class OverlayState: ObservableObject {
  static let shared = OverlayState()

  @Published var expanded = false
  @Published var question = ""
  @Published var answer: String = ""
  @Published var isLoading = false
  @Published var error: String? = nil
  @Published var contextNote: String? = nil

  func ask() async {
    let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return }
    isLoading = true; error = nil; answer = ""
    let ctx = await ScreenCapturer.shared.captureFocusedText()
    if let ctx, !ctx.text.isEmpty {
      contextNote = "reading \(ctx.app)"
    } else {
      contextNote = "no screen context"
    }
    do {
      answer = try await AppState.shared.askOverlay(text: q, screenContext: ctx)
    } catch {
      self.error = error.localizedDescription
    }
    isLoading = false
  }
}
