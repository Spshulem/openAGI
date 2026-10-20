import XCTest
@testable import OpenAGI

final class AppLinkTests: XCTestCase {
  func testPrivacyEntryPoints() {
    for value in ["openagi://privacy", "openagi://privacy/", "OPENAGI://PRIVACY"] {
      XCTAssertTrue(AppLink.opensPrivacy(URL(string: value)!), value)
    }
  }

  func testLinksCannotSelectActionsOrOtherDestinations() {
    for value in ["https://privacy", "openagi://wipe", "openagi://privacy/delete",
                  "openagi://privacy?enabled=true", "openagi://privacy#delete",
                  "openagi://user@privacy", "openagi://privacy:80"] {
      XCTAssertFalse(AppLink.opensPrivacy(URL(string: value)!), value)
    }
  }
}
