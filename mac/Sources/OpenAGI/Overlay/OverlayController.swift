import AppKit
import SwiftUI

@MainActor
final class OverlayController {
  static let shared = OverlayController()
  private var panel: NSPanel?

  private static let enabledKey = "openagi.overlay.enabled"
  private static let frameKey = "openagi.overlay.originX"

  static var isEnabled: Bool {
    UserDefaults.standard.object(forKey: enabledKey) == nil ? true : UserDefaults.standard.bool(forKey: enabledKey)
  }
  static func setEnabled(_ on: Bool) {
    UserDefaults.standard.set(on, forKey: enabledKey)
    if on { shared.show() } else { shared.hide() }
  }

  func startIfEnabled() { if Self.isEnabled { show() } }

  func show() {
    if panel == nil { panel = makePanel() }
    positionPanel()
    panel?.orderFrontRegardless()
  }

  func hide() { panel?.orderOut(nil) }

  func toggle() {
    if panel?.isVisible == true {
      OverlayState.shared.expanded.toggle()
      sizeToContent()
      if OverlayState.shared.expanded { panel?.makeKey() }
    } else {
      OverlayState.shared.expanded = true
      show(); sizeToContent()
      panel?.makeKey()
    }
  }

  private func makePanel() -> NSPanel {
    let p = KeyableOverlayPanel(
      contentRect: NSRect(x: 0, y: 0, width: 320, height: 60),
      styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isMovableByWindowBackground = true
    p.backgroundColor = .clear
    p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let host = NSHostingView(rootView: OverlayView(onCollapse: { [weak self] in self?.sizeToContent() }))
    host.translatesAutoresizingMaskIntoConstraints = true
    p.contentView = host
    return p
  }

  private func sizeToContent() {
    guard let p = panel, let host = p.contentView else { return }
    let fitting = host.fittingSize
    var frame = p.frame
    let newH = max(44, fitting.height)
    frame.origin.y += (frame.height - newH)
    frame.size.height = newH
    frame.size.width = OverlayState.shared.expanded ? 320 : 44
    p.setFrame(frame, display: true, animate: false)
  }

  private func positionPanel() {
    guard let p = panel, let screen = NSScreen.main else { return }
    let d = UserDefaults.standard
    if d.object(forKey: Self.frameKey) != nil {
      let x = d.double(forKey: Self.frameKey)
      let y = d.double(forKey: "openagi.overlay.originY")
      p.setFrameOrigin(NSPoint(x: x, y: y))
    } else {
      let vf = screen.visibleFrame
      p.setFrameOrigin(NSPoint(x: vf.maxX - 360, y: vf.minY + 80))
    }
    sizeToContent()
  }

  func persistPosition() {
    guard let p = panel else { return }
    UserDefaults.standard.set(Double(p.frame.origin.x), forKey: Self.frameKey)
    UserDefaults.standard.set(Double(p.frame.origin.y), forKey: "openagi.overlay.originY")
  }
}

// Borderless NSPanels return false for canBecomeKey by default; override so the
// Quick Ask field can receive keystrokes. .nonactivatingPanel keeps the owning
// app from activating, so summoning never steals focus from the user's app.
final class KeyableOverlayPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}
