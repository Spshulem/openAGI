import AppKit
import SwiftUI
import XCTest
@testable import OpenAGI

/// Review screenshots of a Needs You ask with several questions: the card
/// with its questions inline, one walkthrough page, and the partly answered
/// card in the workspace detail. Writes PNGs only when OPENAGI_UI_SNAPSHOT_DIR
/// is set (CI uploads them).
///
/// Same caveat as FleetDecisionViewSnapshotTests: the fixture goes straight
/// to FleetConsumer.shared, so never set the variable next to a real daemon.
@MainActor
final class FleetQuestionItemsSnapshotTests: XCTestCase {
  private var outputDirectory: URL?

  override func setUp() async throws {
    guard let dir = ProcessInfo.processInfo.environment["OPENAGI_UI_SNAPSHOT_DIR"], !dir.isEmpty else {
      throw XCTSkip("Set OPENAGI_UI_SNAPSHOT_DIR to write question walkthrough review screenshots.")
    }
    let url = URL(fileURLWithPath: dir, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    outputDirectory = url
    _ = NSApplication.shared
    let state = try JSONDecoder().decode(FleetState.self, from: Data(FleetQuestionItemsFixture.stateJSON.utf8))
    XCTAssertEqual(state.questions.map(\.id), ["fq_release", "fq_release_partial", "fq_single"])
    FleetConsumer.shared.apply(state)
  }

  override func tearDown() async throws {
    // Closing every question also clears the drafts these tests saved.
    FleetConsumer.shared.apply(try JSONDecoder().decode(FleetState.self, from: Data("{}".utf8)))
  }

  /// The Needs You card: the questions inline and "Review 10 questions",
  /// with no answer-all or accept-recommendations button.
  func testRenderGroupedCards() throws {
    for id in ["fq_release", "fq_release_partial"] {
      let question = try XCTUnwrap(FleetConsumer.shared.question(id))
      let card = FleetQuestionAnswer(question: question)
        .padding(12)
        .frame(width: 420, alignment: .topLeading)
        .background(WorkspaceTheme.surface)
        .frame(width: 460, height: 760, alignment: .topLeading)
        .background(WorkspaceTheme.canvas)
      try render(card, appearance: .darkAqua, size: NSSize(width: 460, height: 760), file: "mac-question-items-card-\(slug(id))-dark")
      if id == "fq_release" {
        try render(card, appearance: .aqua, size: NSSize(width: 460, height: 760), file: "mac-question-items-card-\(slug(id))-light")
      }
    }
  }

  /// One walkthrough page: "3 of 10", the choices (none preselected, the
  /// recommendation as text), a typed draft elsewhere, and Send.
  func testRenderWalkthroughPage() throws {
    let fleet = FleetConsumer.shared
    let question = try XCTUnwrap(fleet.question("fq_release"))
    let card = try XCTUnwrap(fleet.questionItemsCard(for: question))
    fleet.setItemAnswer("Host B, uncached", questionId: question.id, itemId: "q2-1102b412")
    fleet.skipItem(questionId: question.id, itemId: "q1-b1dbd1d7")
    fleet.startWalkthrough(question)
    fleet.moveWalkthrough(question.id, to: 2)
    let page = NeedsYouQuestionWalkthrough(question: question, card: card, compact: true)
      .padding(12)
      .frame(width: 420, alignment: .topLeading)
      .background(WorkspaceTheme.surface)
      .frame(width: 460, height: 520, alignment: .topLeading)
      .background(WorkspaceTheme.canvas)
    try render(page, appearance: .darkAqua, size: NSSize(width: 460, height: 520), file: "mac-question-items-walkthrough-dark")
    try render(page, appearance: .aqua, size: NSSize(width: 460, height: 520), file: "mac-question-items-walkthrough-light")

    let nav = SupervisorWorkspaceNavigation()
    nav.selectedChannel = .needsYou
    nav.requestedQuestionID = question.id
    try render(SupervisorWorkspaceView(nav: nav), appearance: .darkAqua, file: "mac-question-items-walkthrough-detail-dark")
    fleet.closeWalkthrough(question.id)
  }

  /// The partly answered card in the workspace detail: delivered, failed
  /// (answer kept, Retry), skipped and not answered, side by side.
  func testRenderPartlyAnsweredDetail() throws {
    for appearance in [NSAppearance.Name.darkAqua, .aqua] {
      let nav = SupervisorWorkspaceNavigation()
      nav.selectedChannel = .needsYou
      nav.requestedQuestionID = "fq_release_partial"
      try render(SupervisorWorkspaceView(nav: nav), appearance: appearance,
                 file: "mac-question-items-detail-partial-\(appearance == .darkAqua ? "dark" : "light")")
    }
  }

  private func slug(_ id: String) -> String { id.replacingOccurrences(of: "fq_", with: "") }

  private func render<V: View>(_ view: V, appearance: NSAppearance.Name, size: NSSize = NSSize(width: 1320, height: 860), file: String) throws {
    guard let dir = outputDirectory else { return }
    try WorkspaceSnapshotRenderer.render(view, appearance: appearance, size: size, directory: dir, name: file)
  }
}
