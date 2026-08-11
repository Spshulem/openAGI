import XCTest
@testable import OpenAGI

final class ScreenRecordingPermissionPolicyTests: XCTestCase {
  private let releaseA = "signed-release-a"
  private let localB = "local-build-b"

  func testGrantedPreflightNeverRequests() {
    XCTAssertEqual(decide(granted: true), .alreadyGranted)
  }

  func testFirstUseRequestsOnce() {
    XCTAssertEqual(decide(), .request)
    XCTAssertEqual(decide(requested: [releaseA]), .previouslyRequested)
  }

  func testPreviouslyGrantedIdentityDoesNotRequestWhenPreflightTemporarilyFails() {
    XCTAssertEqual(decide(grantedHistory: [releaseA]), .previouslyGranted)
  }

  func testAlternatingBuildsDoesNotForgetEarlierGrant() {
    let history: Set<String> = [releaseA, localB]
    XCTAssertEqual(decide(identity: releaseA, grantedHistory: history), .previouslyGranted)
    XCTAssertEqual(decide(identity: localB, grantedHistory: history), .previouslyGranted)
    XCTAssertEqual(decide(identity: "new-signing-identity", grantedHistory: history), .request)
  }

  func testInactiveCaptureCancelsAutomaticRequestDecision() {
    XCTAssertEqual(decide(active: false), .inactive)
  }

  func testPermissionHistoryMigrationIsScopedToSigningIdentity() {
    let versions = [localB: 1]
    XCTAssertFalse(ScreenRecordingPermissionPolicy.needsHistoryMigration(
      identity: localB, storedVersions: versions, currentVersion: 1))
    XCTAssertTrue(ScreenRecordingPermissionPolicy.needsHistoryMigration(
      identity: releaseA, storedVersions: versions, currentVersion: 1))
  }

  private func decide(
    active: Bool = true,
    granted: Bool = false,
    identity: String? = nil,
    grantedHistory: Set<String> = [],
    requested: Set<String> = []
  ) -> ScreenRecordingPermissionDecision {
    ScreenRecordingPermissionPolicy.identityAwareDecision(
      captureActive: active,
      preflightGranted: granted,
      identity: identity ?? releaseA,
      grantedIdentities: grantedHistory,
      automaticOnboardingConsumedIdentities: requested)
  }
}
