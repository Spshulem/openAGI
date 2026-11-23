import AppKit
import SwiftUI
import XCTest
@testable import OpenAGI

/// Renders the Supervisor workspace's Needs You screen with synthetic,
/// long and noisy data, offscreen, for review. Writes PNGs only when
/// OPENAGI_UI_SNAPSHOT_DIR is set (CI uploads them); otherwise skipped.
///
/// The fixture is applied straight to FleetConsumer. Its own refresh goes
/// to the default daemon port; nothing listens there on CI, so the refresh
/// fails and leaves the fixture in place. Never set the variable on a
/// machine running a real daemon: its data would end up in the images.
@MainActor
final class FleetNeedsYouSnapshotTests: XCTestCase {
  private var outputDirectory: URL?

  override func setUp() async throws {
    guard let dir = ProcessInfo.processInfo.environment["OPENAGI_UI_SNAPSHOT_DIR"], !dir.isEmpty else {
      throw XCTSkip("Set OPENAGI_UI_SNAPSHOT_DIR to write Needs You review screenshots.")
    }
    let url = URL(fileURLWithPath: dir, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    outputDirectory = url
    _ = NSApplication.shared
    let state = try JSONDecoder().decode(FleetState.self, from: Data(NeedsYouFixture.stateJSON.utf8))
    XCTAssertEqual(state.questions.count, 15)
    FleetConsumer.shared.apply(state)
  }

  func testRenderNeedsYouList() throws {
    for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
      let nav = SupervisorWorkspaceNavigation()
      nav.selectedChannel = .needsYou
      try render(SupervisorWorkspaceView(nav: nav), appearance: appearance, file: "mac-needs-you-list-\(name).png")
    }
  }

  func testRenderSelectedDecisionInInspector() throws {
    for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
      let nav = SupervisorWorkspaceNavigation()
      nav.selectedChannel = .needsYou
      nav.requestedQuestionID = "ny-deploy"
      try render(SupervisorWorkspaceView(nav: nav), appearance: appearance, file: "mac-needs-you-inspector-\(name).png")
    }
  }

  func testRenderProjectChannelDecisions() throws {
    let nav = SupervisorWorkspaceNavigation()
    nav.selectedChannel = .project("harbor")
    try render(SupervisorWorkspaceView(nav: nav), appearance: .darkAqua, file: "mac-project-harbor-dark.png")
  }

  private func render<V: View>(_ view: V, appearance: NSAppearance.Name, file: String) throws {
    guard let dir = outputDirectory else { return }
    try WorkspaceSnapshotRenderer.render(view, appearance: appearance, directory: dir, name: (file as NSString).deletingPathExtension)
  }
}
