import AppKit
import XCTest
@testable import OpenAGI

final class OverlayDragTests: XCTestCase {
  @MainActor func testClickMakesPanelKeyBeforeInvokingExpansion() {
    let panel = FocusTrackingPanel(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: true)
    let handle = DragHandleView(frame: .zero)
    panel.contentView = handle
    handle.onClick = { XCTAssertTrue(panel.requestedKey) }
    handle.performClick()
    XCTAssertTrue(panel.requestedKey)
  }

  @MainActor func testAccessibilityActivatesPillButNotHeader() {
    let handle = DragHandleView(frame: .zero)
    XCTAssertFalse(handle.isAccessibilityElement())
    XCTAssertFalse(handle.accessibilityPerformPress())
    var clicks = 0
    handle.onClick = { clicks += 1 }
    XCTAssertTrue(handle.isAccessibilityElement())
    XCTAssertEqual(handle.accessibilityRole(), .button)
    XCTAssertTrue(handle.accessibilityPerformPress())
    XCTAssertEqual(clicks, 1)
  }

  @MainActor func testOversizedPanelFitsSmallerDisplay() {
    let visible = NSRect(x: -1280, y: 30, width: 1280, height: 690)
    let fitted = KeyableOverlayPanel.fittedDragFrame(
      NSRect(x: -100, y: -100, width: 320, height: 1100), in: visible)
    XCTAssertEqual(fitted, NSRect(x: -320, y: 30, width: 320, height: 690))
  }

  @MainActor func testNormalDragPreservesSizeAndPosition() {
    let frame = NSRect(x: 100, y: 100, width: 44, height: 44)
    XCTAssertEqual(KeyableOverlayPanel.fittedDragFrame(frame,
      in: NSRect(x: 0, y: 0, width: 1000, height: 800)), frame)
  }
}

@MainActor private final class FocusTrackingPanel: NSPanel {
  var requestedKey = false
  override func makeKey() { requestedKey = true }
}
