import AppKit
import SwiftUI

@MainActor
final class OverlayController {
  static let shared = OverlayController()
  private(set) var panel: NSPanel?
  private let defaults: UserDefaults
  private var screenObserver: NSObjectProtocol?
  /// True while an OverlayDragView is moving the panel. Content-driven
  /// resizes wait for the drop so they never fight the drag.
  private(set) var isDragging = false
  /// Where the collapsed dot lives. Collapsing always returns here, expanding
  /// grows from here, and this is what gets saved. Deriving the dot from the
  /// expanded frame instead moved it whenever the expanded panel had been
  /// clamped (dot near the bottom) or had grown past the screen's center.
  private(set) var pillHome: NSRect?
  /// Which edge the expanded panel keeps lined up with the dot. Chosen once,
  /// from the dot, when expanding; reused until the next collapse.
  private var expandAnchorRight: Bool?
  /// Whether the last layout sizeToContent applied was the expanded panel.
  private var laidOutExpanded = false
  /// The frame the last layout asked for. Mid-animation, panel.frame is an
  /// in-between frame; later resizes build on where the panel is going.
  private var layoutFrame: NSRect?
  /// Tests turn this off so frames land without waiting on window animations.
  var animatesResizes = true
  private var dragStartFrame: NSRect?
  private var dragStartHome: NSRect?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  private static let enabledKey = "openagi.overlay.enabled"
  // Where the collapsed pill sits: its bottom-left corner. Size-independent,
  // so a position saved while expanded restores without a jump.
  static let pillOriginXKey = "openagi.overlay.pillOriginX"
  static let pillOriginYKey = "openagi.overlay.pillOriginY"
  // Legacy: the raw frame origin of whatever size the panel had.
  private static let legacyOriginXKey = "openagi.overlay.originX"
  private static let legacyOriginYKey = "openagi.overlay.originY"

  // Panel geometry. The expanded width matches OverlayView's fixed frame.
  private static let expandedWidth: CGFloat = 320
  nonisolated static let pillSize: CGFloat = 44
  nonisolated static let screenMargin: CGFloat = 12

  static var isEnabled: Bool {
    UserDefaults.standard.object(forKey: enabledKey) == nil ? true : UserDefaults.standard.bool(forKey: enabledKey)
  }
  static func setEnabled(_ on: Bool) {
    UserDefaults.standard.set(on, forKey: enabledKey)
    if on { shared.show() } else { shared.hide() }
  }

  func startIfEnabled() { if Self.isEnabled { show() } }

  func show() {
    if panel == nil {
      panel = makePanel()
      // Restore the saved spot only once. Re-applying it on every show()
      // (tray, notifications) would snap the panel back from where the owner
      // dragged it; later shows just keep it on-screen.
      positionPanel()
    } else {
      sizeToContent(animate: false)
    }
    panel?.orderFrontRegardless()
  }

  func hide() {
    VoiceSession.shared.stop()
    panel?.orderOut(nil)
  }

  var panelWindowNumber: Int? { panel?.windowNumber }

  func toggle() {
    guard Self.isEnabled else { return }
    // ⌥Space means "ask about my screen": open on Tasks, whichever tab was
    // left showing. Notification and tray opens pick their own tab.
    if panel?.isVisible != true || !OverlayState.shared.expanded { OverlayState.shared.selectTab(.tasks) }
    if panel?.isVisible == true {
      withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) {
        OverlayState.shared.expanded.toggle()
      }
      if !OverlayState.shared.expanded { VoiceSession.shared.stop() }
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
    VoiceSession.shared.stop()
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
    // OverlayDragView owns dragging (pill and header). A movable background
    // would only compete with it, and could move the panel without saving.
    p.isMovableByWindowBackground = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let host = NSHostingView(rootView: OverlayView(
      onCollapse: { [weak self] in self?.sizeToContent() },
      onExpand: { [weak self] in DispatchQueue.main.async { self?.sizeToContent() } },
      // Content grows after the fact (answer arrives, nudges land, errors
      // show). Without this hook the panel kept its stale frame and the
      // reply rendered clipped / spilling past the panel edge.
      onContentChange: { [weak self] in DispatchQueue.main.async { self?.sizeToContent() } },
      onDragBegan: { [weak self] in self?.beginDrag() },
      onDragEnded: { [weak self] cursor in self?.endDrag(cursor: cursor) }
    ))
    host.translatesAutoresizingMaskIntoConstraints = true
    p.contentView = host
    // A monitor unplugged or rearranged can leave the panel off-screen.
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.sizeToContent(animate: false) }
    }
    return p
  }

  // MARK: Dragging

  func beginDrag() {
    isDragging = true
    guard let p = panel else { return }
    // Stop a running resize animation where it is; otherwise it keeps
    // writing frames underneath the drag.
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0
      p.animator().setFrame(p.frame, display: false)
    }
    dragStartFrame = p.frame
    dragStartHome = pillHome
  }

  /// Drop: fit the panel onto the display under the cursor (shrinking it for
  /// a shorter display), move the dot's home by the same amount the panel
  /// moved, re-measure content that changed mid-drag, and save.
  func endDrag(cursor: NSPoint) {
    guard isDragging else { return }
    isDragging = false
    guard let p = panel else { return }
    let screen = NSScreen.screens.first { $0.frame.contains(cursor) } ?? p.screen ?? NSScreen.main
    var fitted = p.frame
    if let vf = screen?.visibleFrame {
      fitted = Self.clampedFrame(p.frame, in: vf)
      if fitted != p.frame { p.setFrame(fitted, display: true) }
    }
    let start = dragStartFrame ?? fitted
    let startHome = dragStartHome ?? Self.pillFrame(for: start, anchorRight: expandAnchorRight ?? false)
    dragStartFrame = nil
    dragStartHome = nil
    // The dot rides along with the panel: same x shift, same top-edge shift
    // (the clamp keeps the top when it shrinks the panel).
    var home = startHome.offsetBy(dx: fitted.minX - start.minX, dy: fitted.maxY - start.maxY)
    if let vf = screen?.visibleFrame { home = Self.clampedFrame(home, in: vf) }
    pillHome = home
    layoutFrame = fitted
    sizeToContent(animate: false)
    persistPosition()
  }

  /// `frame` moved fully inside `visible`, inset by the screen margin, and
  /// shrunk first if it does not fit.
  static func clampedFrame(_ frame: NSRect, in visible: NSRect, margin: CGFloat = screenMargin) -> NSRect {
    let area = visible.insetBy(dx: margin, dy: margin)
    let w = min(frame.width, area.width)
    let h = min(frame.height, area.height)
    // Keep the top edge when shrinking: content grows downward.
    let y = frame.maxY - h
    return NSRect(
      x: min(max(area.minX, frame.minX), area.maxX - w),
      y: min(max(area.minY, y), area.maxY - h),
      width: w, height: h)
  }

  /// The pill-sized box at the top corner of `frame` on the anchored side.
  /// Only a fallback for when no home has been recorded yet.
  static func pillFrame(for frame: NSRect, anchorRight: Bool) -> NSRect {
    let x = anchorRight ? frame.maxX - pillSize : frame.minX
    return NSRect(x: x, y: frame.maxY - pillSize, width: pillSize, height: pillSize)
  }

  /// The expanded panel's frame grown from the dot at `home`: top edges
  /// aligned, the anchored side's edges aligned, then clamped on-screen.
  static func expandedFrame(from home: NSRect, size: NSSize, anchorRight: Bool, in vf: NSRect) -> NSRect {
    let x = anchorRight ? home.maxX - size.width : home.minX
    return clampedFrame(NSRect(x: x, y: home.maxY - size.height, width: size.width, height: size.height), in: vf)
  }

  /// The visible frame of the display showing `rect`, or the main display's.
  /// The display is picked by its full frame, so a dot sitting in a menu-bar
  /// or Dock strip stays on its own display instead of snapping to main.
  private static func visibleFrame(containing rect: NSRect) -> NSRect? {
    (screen(containing: rect) ?? NSScreen.main)?.visibleFrame
  }

  /// The display whose full frame overlaps `rect` the most, if any does.
  static func screen(containing rect: NSRect, in screens: [NSScreen] = NSScreen.screens) -> NSScreen? {
    func overlap(_ s: NSScreen) -> CGFloat {
      let r = s.frame.intersection(rect)
      return r.isNull ? 0 : r.width * r.height
    }
    guard let best = screens.max(by: { overlap($0) < overlap($1) }), overlap(best) > 0 else { return nil }
    return best
  }

  /// Where 0.0.46 and earlier showed the dot for a saved legacy origin: that
  /// build put the origin on a 320x60 frame and shrank it to the pill at the
  /// top corner on the side nearer the screen edge. An origin saved while
  /// Quick Ask was open comes back where that build would have shown it too.
  static func legacyPillFrame(origin: NSPoint, in vf: NSRect) -> NSRect {
    let old = NSRect(x: origin.x, y: origin.y, width: expandedWidth, height: 60)
    return pillFrame(for: old, anchorRight: old.midX > vf.midX)
  }

  /// Resize the panel to fit its SwiftUI content, animated, WITHOUT ever
  /// leaving the screen. Collapsed, the panel is exactly the dot's home.
  /// Expanding grows from the home: top edges aligned, height growing
  /// downward, and the side chosen once from the dot (a dot on the right half
  /// grows leftward instead of off-screen). Later content changes keep the
  /// expanded panel's top edge and that side. Every frame is clamped inside
  /// the screen's visible frame.
  private var resizeRevision: UInt64 = 0

  private func sizeToContent(animate: Bool = true, isFollowUp: Bool = false) {
    // endDrag runs this once at the drop.
    guard !isDragging else { return }
    guard let p = panel, let host = p.contentView else { return }
    if !isFollowUp { resizeRevision &+= 1 }
    let rev = resizeRevision
    let old = p.frame
    let base = layoutFrame ?? old
    let expanded = OverlayState.shared.expanded

    // The home must stay on a connected display.
    let rawHome = pillHome ?? Self.pillFrame(for: old, anchorRight: expandAnchorRight ?? false)
    guard let homeVF = Self.visibleFrame(containing: rawHome) else { return }
    let home = Self.clampedFrame(rawHome, in: homeVF)
    pillHome = home

    let target: NSRect
    if !expanded {
      expandAnchorRight = nil
      laidOutExpanded = false
      target = home
    } else {
      let fromHome = !laidOutExpanded
      let vf = fromHome ? homeVF : ((p.screen ?? NSScreen.main)?.visibleFrame ?? homeVF)
      let maxH = vf.height - Self.screenMargin * 2
      let size = NSSize(width: Self.expandedWidth, height: min(max(Self.pillSize, host.fittingSize.height), maxH))
      let anchorRight = expandAnchorRight ?? (home.midX > homeVF.midX)
      expandAnchorRight = anchorRight
      laidOutExpanded = true
      if fromHome {
        target = Self.expandedFrame(from: home, size: size, anchorRight: anchorRight, in: vf)
      } else {
        // Already open: keep the top edge and the anchored side where they are.
        let x = anchorRight ? base.maxX - size.width : base.minX
        target = Self.clampedFrame(NSRect(x: x, y: base.maxY - size.height, width: size.width, height: size.height), in: vf)
      }
    }
    layoutFrame = target
    guard target != old else { return }

    if animate && animatesResizes {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.22
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ctx.allowsImplicitAnimation = true
        p.animator().setFrame(target, display: true)
      }
    } else {
      p.setFrame(target, display: true)
    }
    if expanded && !isFollowUp {
      DispatchQueue.main.async { [weak self] in
        guard let self, self.resizeRevision == rev, !self.isDragging else { return }
        self.sizeToContent(animate: false, isFollowUp: true)
      }
    }
  }

  private func positionPanel() {
    guard let p = panel, let screen = NSScreen.main else { return }
    let home: NSRect
    if let saved = savedPillFrame(),
       let display = Self.screen(containing: saved) {
      // A saved spot is only trustworthy while a display still shows it;
      // after unplugging a monitor it can be entirely off-screen.
      home = Self.clampedFrame(saved, in: display.visibleFrame)
    } else {
      let vf = screen.visibleFrame
      // Default: upper-right, where downward growth has the most room.
      home = NSRect(x: vf.maxX - 40 - Self.pillSize, y: vf.maxY - 184,
                    width: Self.pillSize, height: Self.pillSize)
    }
    pillHome = home
    laidOutExpanded = false
    expandAnchorRight = nil
    p.setFrame(home, display: false)
    sizeToContent(animate: false)
  }

  private func savedPillFrame() -> NSRect? {
    let size = NSSize(width: Self.pillSize, height: Self.pillSize)
    if defaults.object(forKey: Self.pillOriginXKey) != nil, defaults.object(forKey: Self.pillOriginYKey) != nil {
      let origin = NSPoint(x: defaults.double(forKey: Self.pillOriginXKey), y: defaults.double(forKey: Self.pillOriginYKey))
      return NSRect(origin: origin, size: size)
    }
    // Older builds saved a frame origin without its size, open or closed.
    if defaults.object(forKey: Self.legacyOriginXKey) != nil {
      let origin = NSPoint(x: defaults.double(forKey: Self.legacyOriginXKey), y: defaults.double(forKey: Self.legacyOriginYKey))
      let old = NSRect(x: origin.x, y: origin.y, width: Self.expandedWidth, height: 60)
      guard let vf = (Self.screen(containing: old) ?? NSScreen.main)?.visibleFrame else { return nil }
      return Self.legacyPillFrame(origin: origin, in: vf)
    }
    return nil
  }

  func persistPosition() {
    guard let p = panel else { return }
    let pill = pillHome ?? Self.pillFrame(for: p.frame, anchorRight: expandAnchorRight ?? false)
    defaults.set(Double(pill.minX), forKey: Self.pillOriginXKey)
    defaults.set(Double(pill.minY), forKey: Self.pillOriginYKey)
  }
}

// Borderless NSPanels return false for canBecomeKey by default; override so the
// Quick Ask field can receive keystrokes. .nonactivatingPanel keeps the owning
// app from activating, so summoning never steals focus from the user's app.
final class KeyableOverlayPanel: NSPanel {
  /// Set while a mouse-down on a drag handle is dispatched, so pressing or
  /// dragging the pill does not take keyboard focus from the owner's app.
  /// A click (no drag) makes the panel key itself before expanding.
  private var deferKeyForDragHandle = false

  override var canBecomeKey: Bool { !deferKeyForDragHandle }

  override func sendEvent(_ event: NSEvent) {
    guard event.type == .leftMouseDown, !isKeyWindow, let content = contentView else {
      super.sendEvent(event)
      return
    }
    let point = content.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
    guard content.hitTest(point) is OverlayDragView else {
      super.sendEvent(event)
      return
    }
    deferKeyForDragHandle = true
    defer { deferKeyForDragHandle = false }
    super.sendEvent(event)
  }

  // Esc anywhere in the panel collapses back to the pill instead of beeping.
  override func cancelOperation(_ sender: Any?) {
    Task { @MainActor in OverlayController.shared.collapse() }
  }
}
