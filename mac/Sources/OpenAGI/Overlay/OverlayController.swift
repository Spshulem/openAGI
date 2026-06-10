import AppKit
import SwiftUI

@MainActor
final class OverlayController {
  static let shared = OverlayController()
  private var panel: NSPanel?

  private static let enabledKey = "openagi.overlay.enabled"
  private static let frameKey = "openagi.overlay.originX"

  // Panel geometry. The expanded width matches OverlayView's fixed frame.
  private static let expandedWidth: CGFloat = 320
  private static let pillSize: CGFloat = 44
  private static let screenMargin: CGFloat = 12

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

  var panelWindowNumber: Int? { panel?.windowNumber }

  func toggle() {
    guard Self.isEnabled else { return }
    if panel?.isVisible == true {
      withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) {
        OverlayState.shared.expanded.toggle()
      }
      sizeToContent()
      if OverlayState.shared.expanded { panel?.makeKey() }
    } else {
      OverlayState.shared.expanded = true
      show(); sizeToContent(animate: false)
      panel?.makeKey()
    }
  }

  /// Esc from anywhere in the panel collapses back to the pill.
  func collapse() {
    guard OverlayState.shared.expanded else { return }
    withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) {
      OverlayState.shared.expanded = false
    }
    sizeToContent()
  }

  private func makePanel() -> NSPanel {
    let p = KeyableOverlayPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.expandedWidth, height: 60),
      styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isMovableByWindowBackground = true
    p.backgroundColor = .clear
    p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let host = NSHostingView(rootView: OverlayView(
      onCollapse: { [weak self] in self?.sizeToContent() },
      onExpand: { [weak self] in DispatchQueue.main.async { self?.sizeToContent() } },
      // Content grows after the fact (answer arrives, nudges land, errors
      // show). Without this hook the panel kept its stale frame and the
      // reply rendered clipped / spilling past the panel edge.
      onContentChange: { [weak self] in DispatchQueue.main.async { self?.sizeToContent() } }
    ))
    host.translatesAutoresizingMaskIntoConstraints = true
    p.contentView = host
    return p
  }

  /// Resize the panel to fit its SwiftUI content, animated, WITHOUT ever
  /// leaving the screen: the top edge stays put while height grows downward,
  /// the horizontal anchor is whichever edge is nearer a screen edge (so a
  /// pill parked on the right expands leftward instead of off-screen), and
  /// the final frame is clamped inside the screen's visible frame.
  private func sizeToContent(animate: Bool = true) {
    guard let p = panel, let host = p.contentView else { return }
    let screen = p.screen ?? NSScreen.main
    guard let vf = screen?.visibleFrame else { return }
    let m = Self.screenMargin
    let expanded = OverlayState.shared.expanded

    let fitting = host.fittingSize
    let newW = expanded ? Self.expandedWidth : Self.pillSize
    let maxH = vf.height - m * 2
    let newH = min(max(Self.pillSize, fitting.height), maxH)

    let old = p.frame
    let anchorRight = old.midX > vf.midX
    var newX = anchorRight ? old.maxX - newW : old.minX
    var newY = old.maxY - newH // keep the top edge fixed; grow downward

    newX = min(max(vf.minX + m, newX), vf.maxX - m - newW)
    newY = min(max(vf.minY + m, newY), vf.maxY - m - newH)
    let target = NSRect(x: newX, y: newY, width: newW, height: newH)
    guard target != old else { return }

    if animate {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.22
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ctx.allowsImplicitAnimation = true
        p.animator().setFrame(target, display: true)
      }
    } else {
      p.setFrame(target, display: true)
    }
  }

  private func positionPanel() {
    guard let p = panel, let screen = NSScreen.main else { return }
    let d = UserDefaults.standard
    var placed = false
    if d.object(forKey: Self.frameKey) != nil {
      let saved = NSPoint(x: d.double(forKey: Self.frameKey), y: d.double(forKey: "openagi.overlay.originY"))
      // A saved origin is only trustworthy while the screen layout that
      // produced it still exists — after unplugging a monitor or changing
      // resolution it can be entirely off-screen.
      let onSomeScreen = NSScreen.screens.contains { $0.visibleFrame.insetBy(dx: -8, dy: -8).contains(saved) }
      if onSomeScreen {
        p.setFrameOrigin(saved)
        placed = true
      }
    }
    if !placed {
      let vf = screen.visibleFrame
      // Default: upper-right, where downward growth has the most room.
      p.setFrameOrigin(NSPoint(
        x: vf.maxX - Self.expandedWidth - 40,
        y: vf.maxY - 200
      ))
    }
    sizeToContent(animate: false)
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

  // Esc anywhere in the panel collapses back to the pill instead of beeping.
  override func cancelOperation(_ sender: Any?) {
    Task { @MainActor in OverlayController.shared.collapse() }
  }
}
