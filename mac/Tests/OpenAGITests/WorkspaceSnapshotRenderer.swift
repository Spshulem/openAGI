import AppKit
import SwiftUI

/// Renders a SwiftUI view in a real window for review screenshots (CI only).
///
/// Two images per call: `name.png` from the view hierarchy (no window
/// chrome; glass and sidebar materials draw blank this way), and
/// `name-window.png` from `screencapture` of the window itself, which
/// keeps the materials when the runner allows screen capture.
@MainActor
enum WorkspaceSnapshotRenderer {
  /// Not limited to the runner's small display.
  private final class UnconstrainedWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
  }

  static func render<V: View>(
    _ view: V,
    appearance: NSAppearance.Name,
    size: NSSize = NSSize(width: 1320, height: 860),
    directory: URL,
    name: String
  ) throws {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let host = NSHostingController(rootView: view)
    let window = UnconstrainedWindow(contentViewController: host)
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    window.toolbarStyle = .unified
    window.title = "OpenAGI"
    window.appearance = NSAppearance(named: appearance)
    window.setContentSize(size)
    window.setFrameOrigin(NSPoint(x: 0, y: 0))
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    defer { window.orderOut(nil) }
    // Let SwiftUI lay out, run its .task refreshes (which fail with no
    // daemon), and settle.
    RunLoop.main.run(until: Date().addingTimeInterval(2.5))

    let frameView = window.contentView?.superview ?? window.contentView!
    let bounds = frameView.bounds
    if let rep = frameView.bitmapImageRepForCachingDisplay(in: bounds) {
      frameView.cacheDisplay(in: bounds, to: rep)
      if let png = rep.representation(using: .png, properties: [:]) {
        try png.write(to: directory.appendingPathComponent("\(name).png"))
      }
    }

    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-o", "-l\(window.windowNumber)", directory.appendingPathComponent("\(name)-window.png").path]
    try? capture.run()
    capture.waitUntilExit()
  }
}
