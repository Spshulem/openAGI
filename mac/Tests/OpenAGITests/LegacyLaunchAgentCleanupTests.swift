import XCTest
@testable import OpenAGI

final class LegacyLaunchAgentCleanupTests: XCTestCase {
  func testRecognizesOnlyExactOwnedLegacyAgent() {
    let owned: NSDictionary = [
      "Label": "app.openagi.imessage-bridge",
      "ProgramArguments": ["/usr/bin/node", "/checkout/bin/openagi.js", "imessage-bridge"],
    ]
    XCTAssertTrue(LegacyLaunchAgentCleanup.owns(
      dictionary: owned,
      label: "app.openagi.imessage-bridge",
      expectedCommand: "imessage-bridge"))

    let unrelatedLabel: NSDictionary = [
      "Label": "com.example.bridge",
      "ProgramArguments": ["/usr/bin/node", "imessage-bridge"],
    ]
    XCTAssertFalse(LegacyLaunchAgentCleanup.owns(
      dictionary: unrelatedLabel,
      label: "app.openagi.imessage-bridge",
      expectedCommand: "imessage-bridge"))

    let reusedLabel: NSDictionary = [
      "Label": "app.openagi.imessage-bridge",
      "ProgramArguments": ["/Applications/Unrelated.app/Contents/MacOS/Unrelated"],
    ]
    XCTAssertFalse(LegacyLaunchAgentCleanup.owns(
      dictionary: reusedLabel,
      label: "app.openagi.imessage-bridge",
      expectedCommand: "imessage-bridge"))
  }
}
