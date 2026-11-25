import AppKit
import SwiftUI

/// A native AppKit hit target that moves the borderless Quick Ask panel.
///
/// `isMovableByWindowBackground` never worked for the pill: the view under the
/// mouse was a SwiftUI Button, which takes the mouse-down, so there was no
/// "background" to grab. This view sits on top instead and handles the mouse
/// itself. AppKit keeps sending dragged/up events to the view that got the
/// mouse-down, so no tracking loop is needed and the window's normal event
/// dispatch stays intact.
///
/// A press that moves less than `dragThreshold` and is released inside the
/// view is a click (`onClick`); anything past the threshold is a drag, even if
/// the pointer comes back near where it started.
struct OverlayDragHandle: NSViewRepresentable {
  var onClick: (() -> Void)? = nil
  var onHover: ((Bool) -> Void)? = nil
  var onDragBegan: () -> Void = {}
  var onDragEnded: (NSPoint) -> Void = { _ in }
  var toolTip: String? = nil
  /// Non-nil exposes the handle to VoiceOver as a button with this label.
  var accessibilityButtonLabel: String? = nil

  func makeNSView(context: Context) -> OverlayDragView {
    let view = OverlayDragView(frame: .zero)
    updateNSView(view, context: context)
    return view
  }

  func updateNSView(_ view: OverlayDragView, context: Context) {
    view.onClick = onClick
    view.onHover = onHover
    view.onDragBegan = onDragBegan
    view.onDragEnded = onDragEnded
    view.toolTip = toolTip
    view.accessibilityButtonLabel = accessibilityButtonLabel
  }
}

final class OverlayDragView: NSView {
  static let dragThreshold: CGFloat = 6

  var onClick: (() -> Void)?
  var onHover: ((Bool) -> Void)?
  var onDragBegan: (() -> Void)?
  var onDragEnded: ((NSPoint) -> Void)?
  var accessibilityButtonLabel: String?

  private var startCursor: NSPoint?
  private var startOrigin: NSPoint = .zero
  private(set) var isDragging = false

  override var mouseDownCanMoveWindow: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  // A drag must not pull keyboard focus away from the app the owner is typing
  // in. KeyableOverlayPanel reads this; a click makes the panel key itself.
  override var needsPanelToBecomeKey: Bool { false }

  /// The event's position in global Cocoa screen coordinates.
  ///
  /// Uses the event's CGEvent location, which the window server stamps in
  /// global space. `locationInWindow` is relative to where the window was when
  /// the event was queued, so converting it through the window's frame after
  /// we have already moved the window gives a stale point (jitter and drift).
  static func screenLocation(of event: NSEvent, in window: NSWindow?) -> NSPoint {
    if let cg = event.cgEvent?.location, let primary = NSScreen.screens.first {
      return NSPoint(x: cg.x, y: primary.frame.maxY - cg.y)
    }
    return window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
  }

  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    startCursor = Self.screenLocation(of: event, in: window)
    startOrigin = window.frame.origin
    isDragging = false
  }

  override func mouseDragged(with event: NSEvent) {
    guard let window, let start = startCursor else { return }
    let point = Self.screenLocation(of: event, in: window)
    let dx = point.x - start.x
    let dy = point.y - start.y
    if !isDragging {
      guard hypot(dx, dy) >= Self.dragThreshold else { return }
      isDragging = true
      // The controller stops any running resize animation here, so read the
      // origin after it settles.
      onDragBegan?()
      startOrigin = window.frame.origin
    }
    window.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
  }

  override func mouseUp(with event: NSEvent) {
    guard startCursor != nil else { return }
    startCursor = nil
    if isDragging {
      isDragging = false
      onDragEnded?(Self.screenLocation(of: event, in: window))
    } else if bounds.contains(convert(event.locationInWindow, from: nil)) {
      performClick()
    }
  }

  /// A SwiftUI transition can remove this view mid-press (⌥Space while the
  /// pill is held). Finish the drag so the controller never stays in drag mode.
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil { installHoverArea(); return }
    guard startCursor != nil else { return }
    startCursor = nil
    if isDragging {
      isDragging = false
      onDragEnded?(NSEvent.mouseLocation)
    }
  }

  /// Make the panel key first so the Quick Ask field can take typing, then
  /// run the click action.
  func performClick() {
    window?.makeKey()
    onClick?()
  }

  // MARK: Hover

  // One area for the view's whole life: .inVisibleRect follows the bounds, so
  // it never needs rebuilding. It is added when the view joins a window, not
  // in updateTrackingAreas, which AppKit does not call for this view inside
  // an NSHostingView. Only this area is ours; the tooltip's area is left alone.
  private(set) var hoverArea: NSTrackingArea?

  private func installHoverArea() {
    guard hoverArea == nil else { return }
    let area = NSTrackingArea(
      rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self, userInfo: nil)
    addTrackingArea(area)
    hoverArea = area
  }

  override func mouseEntered(with event: NSEvent) { onHover?(true) }
  override func mouseExited(with event: NSEvent) { onHover?(false) }

  // MARK: Accessibility

  override func isAccessibilityElement() -> Bool { accessibilityButtonLabel != nil }
  override func accessibilityRole() -> NSAccessibility.Role? {
    accessibilityButtonLabel == nil ? super.accessibilityRole() : .button
  }
  override func accessibilityLabel() -> String? { accessibilityButtonLabel ?? super.accessibilityLabel() }
  override func accessibilityPerformPress() -> Bool {
    guard accessibilityButtonLabel != nil, onClick != nil else { return false }
    performClick()
    return true
  }
}
