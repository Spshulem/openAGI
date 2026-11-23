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

  // MARK: - Rendering

  private func render<V: View>(_ view: V, appearance: NSAppearance.Name, file: String, size: NSSize = NSSize(width: 1320, height: 860)) throws {
    let host = NSHostingController(rootView: view)
    let window = NSWindow(contentViewController: host)
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    window.toolbarStyle = .unified
    window.title = "OpenAGI"
    window.appearance = NSAppearance(named: appearance)
    window.setContentSize(size)
    window.orderFront(nil)
    defer { window.orderOut(nil) }
    // Let SwiftUI lay out, run its .task refreshes (which fail with no
    // daemon), and settle.
    RunLoop.main.run(until: Date().addingTimeInterval(2.5))
    let frameView = window.contentView?.superview ?? window.contentView!
    let bounds = frameView.bounds
    guard let rep = frameView.bitmapImageRepForCachingDisplay(in: bounds) else {
      XCTFail("No bitmap for \(file)")
      return
    }
    frameView.cacheDisplay(in: bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]), let dir = outputDirectory else {
      XCTFail("No PNG for \(file)")
      return
    }
    try png.write(to: dir.appendingPathComponent(file))
  }
}
