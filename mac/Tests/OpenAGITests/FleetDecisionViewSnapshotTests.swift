import AppKit
import SwiftUI
import XCTest
@testable import OpenAGI

/// Review screenshots of the four-part decision (Goal, Status, Decision,
/// Recommendation) on the Needs You card and in the detail inspector, for
/// the regression, sparse, older and legacy (no decisionView) cards. Writes
/// PNGs only when OPENAGI_UI_SNAPSHOT_DIR is set (CI uploads them).
///
/// Same caveat as FleetNeedsYouSnapshotTests: the fixture goes straight to
/// FleetConsumer, so never set the variable next to a real daemon.
@MainActor
final class FleetDecisionViewSnapshotTests: XCTestCase {
  private var outputDirectory: URL?
  private static let ids = ["fq_regression", "fq_sparse", "fq_old", "fq_legacy"]

  override func setUp() async throws {
    guard let dir = ProcessInfo.processInfo.environment["OPENAGI_UI_SNAPSHOT_DIR"], !dir.isEmpty else {
      throw XCTSkip("Set OPENAGI_UI_SNAPSHOT_DIR to write decision card review screenshots.")
    }
    let url = URL(fileURLWithPath: dir, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    outputDirectory = url
    _ = NSApplication.shared
    let state = try JSONDecoder().decode(FleetState.self, from: Data(FleetDecisionViewFixture.stateJSON.utf8))
    XCTAssertEqual(state.questions.map(\.id), Self.ids)
    FleetConsumer.shared.apply(state)
  }

  override func tearDown() async throws {
    // Leave the shared consumer as other tests expect it: no supervisor.
    FleetConsumer.shared.apply(try JSONDecoder().decode(FleetState.self, from: Data("{}".utf8)))
  }

  /// The Needs You card (the opened row's question and its answers).
  func testRenderDecisionCards() throws {
    for id in Self.ids {
      let question = try XCTUnwrap(FleetConsumer.shared.question(id))
      let card = FleetQuestionAnswer(question: question)
        .padding(12)
        .frame(width: 420, alignment: .topLeading)
        .background(WorkspaceTheme.surface)
        .frame(width: 460, height: 640, alignment: .topLeading)
        .background(WorkspaceTheme.canvas)
      try render(card, appearance: .darkAqua, size: NSSize(width: 460, height: 640), file: "mac-decision-card-\(slug(id))-dark")
      if id == "fq_regression" {
        try render(card, appearance: .aqua, size: NSSize(width: 460, height: 640), file: "mac-decision-card-\(slug(id))-light")
      }
    }
  }

  /// The detail inspector of the Supervisor workspace.
  func testRenderDecisionDetails() throws {
    for id in Self.ids {
      let nav = SupervisorWorkspaceNavigation()
      nav.selectedChannel = .needsYou
      nav.requestedQuestionID = id
      try render(SupervisorWorkspaceView(nav: nav), appearance: .darkAqua, file: "mac-decision-detail-\(slug(id))-dark")
      if id == "fq_regression" {
        let light = SupervisorWorkspaceNavigation()
        light.selectedChannel = .needsYou
        light.requestedQuestionID = id
        try render(SupervisorWorkspaceView(nav: light), appearance: .aqua, file: "mac-decision-detail-\(slug(id))-light")
      }
    }
  }

  private func slug(_ id: String) -> String { id.replacingOccurrences(of: "fq_", with: "") }

  private func render<V: View>(_ view: V, appearance: NSAppearance.Name, size: NSSize = NSSize(width: 1320, height: 860), file: String) throws {
    guard let dir = outputDirectory else { return }
    try WorkspaceSnapshotRenderer.render(view, appearance: appearance, size: size, directory: dir, name: file)
  }
}
