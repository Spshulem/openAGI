import XCTest
@testable import OpenAGI

final class ProviderSetupStatusTests: XCTestCase {
  func testOfflineStateDoesNotClaimKeysAreMissing() {
    for configured in [nil, true, false] as [Bool?] {
      XCTAssertEqual(ProviderSetupStatus.resolve(daemonResponding: false, configured: configured), .unknown)
    }
  }

  func testMissingHealthFieldIsNotAnUnconfiguredProvider() {
    XCTAssertEqual(ProviderSetupStatus.resolve(daemonResponding: true, configured: nil), .unknown)
  }

  func testOnlyExplicitLiveConfigurationCanRequireSetup() {
    XCTAssertEqual(ProviderSetupStatus.resolve(daemonResponding: true, configured: true), .configured)
    XCTAssertEqual(ProviderSetupStatus.resolve(daemonResponding: true, configured: false), .needsSetup)
  }
}
