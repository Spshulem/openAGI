import AppKit
import SwiftUI

/// A real AppKit drag region for the borderless Quick Ask panel.
///
/// SwiftUI controls win hit testing over `isMovableByWindowBackground`, so the
/// panel needs an explicit surface for both the collapsed pill and its header.
struct WindowDragHandle: NSViewRepresentable {
  var onClick: (() -> Void)? = nil

  func makeNSView(context: Context) -> NSView {
    let view = DragHandleView(frame: .zero)
    view.toolTip = "Drag to move OpenAGI"
    view.onClick = onClick
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    (nsView as? DragHandleView)?.onClick = onClick
  }
}

final class DragHandleView: NSView {
  var onClick: (() -> Void)?

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { true }

  func performClick() {
    guard let onClick else { return }
    window?.makeKey()
    onClick()
  }

  override func isAccessibilityElement() -> Bool { onClick != nil }
  override func accessibilityRole() -> NSAccessibility.Role? { .button }
  override func accessibilityLabel() -> String? { "Quick Ask" }
  override func accessibilityPerformPress() -> Bool {
    guard onClick != nil else { return false }
    performClick()
    return true
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .openHand)
  }
}
