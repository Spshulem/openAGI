import Foundation
import XCTest
@testable import OpenAGI

final class CaptureHealthTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  func testFreshInstallDefaultsToOneDayOfScreenshots() {
    XCTAssertEqual(CaptureSettings.defaultFrameRetentionDays, 1)
    XCTAssertEqual(CaptureSettings.frameRetentionPresets, [1, 3, 7, 30, 90])
  }

  func testPermissionIsNotReportedAsHealthyWithoutSavedFrame() {
    XCTAssertEqual(
      CaptureHealth.evaluate(
        enabled: true,
        pausedUntil: nil,
        screenRecordingGranted: true,
        latestFrameAt: nil,
        captureIntervalSeconds: 5,
        now: now),
      .waitingForFirstFrame)
  }

  func testFreshSavedFrameIsHealthy() {
    let frame = now.addingTimeInterval(-30)
    XCTAssertEqual(
      CaptureHealth.evaluate(
        enabled: true,
        pausedUntil: nil,
        screenRecordingGranted: true,
        latestFrameAt: frame,
        captureIntervalSeconds: 5,
        now: now),
      .healthy(latestFrameAt: frame))
  }

  func testStaleFrameIsReportedEvenWhileCaptureIsEnabled() {
    let frame = now.addingTimeInterval(-61)
    XCTAssertEqual(
      CaptureHealth.evaluate(
        enabled: true,
        pausedUntil: nil,
        screenRecordingGranted: true,
        latestFrameAt: frame,
        captureIntervalSeconds: 5,
        now: now),
      .stale(latestFrameAt: frame))
  }

  func testPermissionFailureWinsOverHistoricalFrame() {
    XCTAssertEqual(
      CaptureHealth.evaluate(
        enabled: true,
        pausedUntil: nil,
        screenRecordingGranted: false,
        latestFrameAt: now,
        captureIntervalSeconds: 5,
        now: now),
      .permissionRequired)
  }

  func testExpiredOrphanedThumbnailsAreRemovedWithoutTouchingFreshFiles() throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("openagi-capture-retention-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }

    let expired = dir.appendingPathComponent("expired.jpg")
    let fresh = dir.appendingPathComponent("fresh.jpg")
    let unrelated = dir.appendingPathComponent("notes.txt")
    try Data([1]).write(to: expired)
    try Data([2]).write(to: fresh)
    try Data([3]).write(to: unrelated)
    try FileManager.default.setAttributes(
      [.modificationDate: now.addingTimeInterval(-2 * 86_400)],
      ofItemAtPath: expired.path)
    try FileManager.default.setAttributes(
      [.modificationDate: now],
      ofItemAtPath: fresh.path)

    XCTAssertEqual(
      CaptureStorage.removeExpiredThumbnails(
        in: dir,
        olderThan: now.addingTimeInterval(-86_400)),
      1)
    XCTAssertFalse(FileManager.default.fileExists(atPath: expired.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
  }

  func testDatabaseCompactionRequiresMaterialFreeSpaceAndRatio() {
    XCTAssertFalse(CaptureStorage.shouldCompactDatabase(
      pageCount: 10_000, freePages: 2_499, pageSize: 4096))
    XCTAssertFalse(CaptureStorage.shouldCompactDatabase(
      pageCount: 10_000, freePages: 2_500, pageSize: 4096))
    XCTAssertTrue(CaptureStorage.shouldCompactDatabase(
      pageCount: 20_000, freePages: 5_000, pageSize: 4096))
  }
}
