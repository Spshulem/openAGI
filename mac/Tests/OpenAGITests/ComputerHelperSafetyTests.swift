import Foundation
import XCTest
import OpenAGIComputerCore

final class ComputerHelperSafetyTests: XCTestCase {
  func testCapturePrivacyFailsClosedOnUnknownIdentity() {
    let privacy = ComputerCapturePrivacy()
    XCTAssertFalse(privacy.permits(bundleId: nil, title: "Document"))
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Editor", title: nil))
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Editor", title: "  "))
  }

  func testCapturePrivacyAlwaysIncludesSensitiveDefaults() {
    let privacy = ComputerCapturePrivacy(excludedBundleIds: [], excludedWindowPatterns: [])
    XCTAssertFalse(privacy.permits(bundleId: "COM.1PASSWORD.browser-helper", title: "Vault"))
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Browser", title: "Private Window"))
    XCTAssertTrue(privacy.permits(bundleId: "com.example.Editor", title: "Project Notes"))
  }

  func testCapturePrivacyLoadsPersistedCustomExclusions() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("openagi-computer-helper-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let settings = directory.appendingPathComponent("settings.json")
    let data = try JSONSerialization.data(withJSONObject: [
      "excludedBundleIds": ["com.example.Private"],
      "excludedWindowPatterns": ["client confidential"]
    ])
    try data.write(to: settings, options: .atomic)

    let privacy = ComputerCapturePrivacy.load(from: settings)
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Private.child", title: "Notes"))
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Editor", title: "Client Confidential Plan"))
    XCTAssertFalse(privacy.permits(bundleId: "com.apple.MobileSMS", title: "Conversation"),
                   "persisted settings must not erase fail-closed defaults")
  }

  func testMalformedPatternStillActsAsLiteralExclusion() {
    let privacy = ComputerCapturePrivacy(
      excludedBundleIds: [],
      excludedWindowPatterns: ["[secret"]
    )
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Editor", title: "Draft [secret notes"))
  }

  func testUnreadableSettingsFailClosed() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("openagi-computer-helper-invalid-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let settings = directory.appendingPathComponent("settings.json")
    try Data("not json".utf8).write(to: settings)

    let privacy = ComputerCapturePrivacy.load(from: settings)
    XCTAssertFalse(privacy.settingsReadable)
    XCTAssertFalse(privacy.permits(bundleId: "com.example.Editor", title: "Project Notes"))
  }

  func testRetinaScreenshotScaleConvertsImagePixelsToGlobalPoints() {
    // A 1600-point Retina window reduced to a 1280-pixel screenshot maps each
    // image pixel to 1.25 display points. The global origin is added after the
    // conversion by the relay.
    let scale = ComputerScreenshot.imageToPointScale(imagePixelWidth: 1_280,
                                                     windowPointWidth: 1_600)
    XCTAssertEqual(scale, 1.25, accuracy: 0.000_001)
    let imageX = 640.0
    let globalOriginX = 120.0
    XCTAssertEqual((imageX + globalOriginX / scale) * scale, 920.0, accuracy: 0.000_001)
  }

  func testInputReadinessRejectsEveryUnsafeLiveState() {
    XCTAssertThrowsError(try ComputerInput.validateInputReadiness(
      accessibilityGranted: false, consoleSessionActive: true,
      screenLocked: false, secureInputEnabled: false))
    XCTAssertThrowsError(try ComputerInput.validateInputReadiness(
      accessibilityGranted: true, consoleSessionActive: false,
      screenLocked: false, secureInputEnabled: false))
    XCTAssertThrowsError(try ComputerInput.validateInputReadiness(
      accessibilityGranted: true, consoleSessionActive: true,
      screenLocked: true, secureInputEnabled: false))
    XCTAssertThrowsError(try ComputerInput.validateInputReadiness(
      accessibilityGranted: true, consoleSessionActive: true,
      screenLocked: false, secureInputEnabled: true))
    XCTAssertNoThrow(try ComputerInput.validateInputReadiness(
      accessibilityGranted: true, consoleSessionActive: true,
      screenLocked: false, secureInputEnabled: false))
  }
}
