import AppKit
import SwiftUI

@MainActor
final class OverlayController {
  static let shared = OverlayController()
  private var panel: NSPanel?
  private var hostingView: NSView?
  private var resizeGeneration = 0

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
      OverlayState.shared.expanded.toggle()
      scheduleSizeToContent()
      if OverlayState.shared.expanded { panel?.makeKey() }
    } else {
      OverlayState.shared.expanded = true
      show(); scheduleSizeToContent()
      panel?.makeKey()
    }
  }

  /// Esc from anywhere in the panel collapses back to the pill.
  func collapse() {
    guard OverlayState.shared.expanded else { return }
    OverlayState.shared.expanded = false
    scheduleSizeToContent()
  }

  private func makePanel() -> NSPanel {
    let p = KeyableOverlayPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.expandedWidth, height: 60),
      styleMask: [.nonactivatingPanel, .borderless],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isMovable = true
    p.isMovableByWindowBackground = true
    p.backgroundColor = .clear
    p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let host = NSHostingView(rootView: OverlayView(
      onCollapse: { [weak self] in self?.scheduleSizeToContent() },
      onExpand: { [weak self] in self?.scheduleSizeToContent() },
      // Content grows after the fact (answer arrives, nudges land, errors
      // show). Without this hook the panel kept its stale frame and the
      // reply rendered clipped / spilling past the panel edge.
      onContentChange: { [weak self] in self?.scheduleSizeToContent() }
    ))
    // The controller owns the panel frame. Prevent NSHostingView from also
    // pushing SwiftUI's changing content constraints back into the window.
    // Two sizing authorities can recurse through AppKit while a drag or panel
    // resize is in flight.
    host.sizingOptions = []
    host.translatesAutoresizingMaskIntoConstraints = true
    let container = NSView(frame: p.contentView?.bounds ?? p.contentLayoutRect)
    host.frame = container.bounds
    host.autoresizingMask = [.width, .height]
    container.addSubview(host)
    p.contentView = container
    hostingView = host
    return p
  }

  /// Coalesce SwiftUI's height changes and resize after the render pass has
  /// unwound, keeping the panel and its drag handling on one sizing path.
  private func scheduleSizeToContent() {
    resizeGeneration &+= 1
    let generation = resizeGeneration
    DispatchQueue.main.async { [weak self] in
      guard let self, generation == self.resizeGeneration else { return }
      self.sizeToContent()
    }
  }

  /// Resize the panel to fit its SwiftUI content WITHOUT ever
  /// leaving the screen: the top edge stays put while height grows downward,
  /// the horizontal anchor is whichever edge is nearer a screen edge (so a
  /// pill parked on the right expands leftward instead of off-screen), and
  /// the final frame is clamped inside the screen's visible frame.
  private func sizeToContent() {
    guard let p = panel, let host = hostingView else { return }
    let screen = p.screen ?? NSScreen.main
    guard let vf = screen?.visibleFrame else { return }
    let m = Self.screenMargin
    let expanded = OverlayState.shared.expanded

    let fitting = host.fittingSize
    let newW = expanded ? Self.expandedWidth : Self.pillSize
    let maxH = vf.height - m * 2
    let newH = expanded ? min(max(Self.pillSize, fitting.height), maxH) : Self.pillSize

    let old = p.frame
    let anchorRight = old.midX > vf.midX
    var newX = anchorRight ? old.maxX - newW : old.minX
    var newY = old.maxY - newH // keep the top edge fixed; grow downward

    newX = min(max(vf.minX + m, newX), vf.maxX - m - newW)
    newY = min(max(vf.minY + m, newY), vf.maxY - m - newH)
    let target = NSRect(x: newX, y: newY, width: newW, height: newH)
    guard target != old else { return }

    // Atomic frame adoption avoids invalidating SwiftUI safe-area constraints
    // while AppKit is already processing a pointer drag.
    p.setFrame(target, display: true)
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
  private static let dragThreshold: CGFloat = 3

  override var canBecomeKey: Bool { true }

  override func sendEvent(_ event: NSEvent) {
    guard event.type == .leftMouseDown,
          let target = dragTarget(at: event.locationInWindow) else {
      super.sendEvent(event)
      return
    }

    let startOrigin = frame.origin
    let startCursor = NSEvent.mouseLocation
    let startLocation = event.locationInWindow
    var didDrag = false
    var finished = false
    while !finished, let next = nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
      switch next.type {
      case .leftMouseDragged:
        let current = resolvedCursor(for: next, startCursor: startCursor, startLocation: startLocation)
        let distance = hypot(current.x - startCursor.x, current.y - startCursor.y)
        guard didDrag || distance >= Self.dragThreshold else { continue }
        didDrag = true
        moveFrom(startOrigin: startOrigin, cursorStart: startCursor, cursorNow: current)
      case .leftMouseUp:
        let current = resolvedCursor(for: next, startCursor: startCursor, startLocation: startLocation)
        let distance = hypot(current.x - startCursor.x, current.y - startCursor.y)
        if !didDrag, distance >= Self.dragThreshold {
          didDrag = true
          moveFrom(startOrigin: startOrigin, cursorStart: startCursor, cursorNow: current)
        }
        finished = true
      default:
        break
      }
    }
    if didDrag { OverlayController.shared.persistPosition() }
    else { target.performClick() }
  }

  private func dragTarget(at point: NSPoint) -> DragHandleView? {
    var candidate = contentView?.hitTest(point)
    while let view = candidate {
      if let target = view as? DragHandleView { return target }
      candidate = view.superview
    }
    return nil
  }

  private func resolvedCursor(for event: NSEvent, startCursor: NSPoint, startLocation: NSPoint) -> NSPoint {
    let global = NSEvent.mouseLocation
    let globalDistance = hypot(global.x - startCursor.x, global.y - startCursor.y)
    let localDelta = NSPoint(
      x: event.locationInWindow.x - startLocation.x,
      y: event.locationInWindow.y - startLocation.y
    )
    let localDistance = hypot(localDelta.x, localDelta.y)
    guard localDistance > globalDistance else { return global }
    return NSPoint(x: startCursor.x + localDelta.x, y: startCursor.y + localDelta.y)
  }

  private func moveFrom(startOrigin: NSPoint, cursorStart: NSPoint, cursorNow current: NSPoint) {
    var proposed = NSPoint(
      x: startOrigin.x + current.x - cursorStart.x,
      y: startOrigin.y + current.y - cursorStart.y
    )
    let targetScreen = NSScreen.screens.first { $0.frame.contains(current) } ?? screen
    if let visible = targetScreen?.visibleFrame {
      proposed.x = min(max(visible.minX, proposed.x), visible.maxX - frame.width)
      proposed.y = min(max(visible.minY, proposed.y), visible.maxY - frame.height)
    }
    setFrameOrigin(proposed)
  }

  // Esc anywhere in the panel collapses back to the pill instead of beeping.
  override func cancelOperation(_ sender: Any?) {
    Task { @MainActor in OverlayController.shared.collapse() }
  }
}
