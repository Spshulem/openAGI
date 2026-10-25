import XCTest
@testable import OpenAGI

final class PhonePairingTests: XCTestCase {
  func testLocalOwnerTokenGoesOnlyToLoopbackAndNeverInURL() {
    let request = PhonePairingWindowController.localRequest(ownerToken: "test-local-owner")
    XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:43210/phone-pairing")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-local-owner")
    XCTAssertEqual(PhonePairingWindowController.cleanNavigation(request), request)
    let cookie = PhonePairingWindowController.localCookie(ownerToken: "test-local-owner")
    XCTAssertEqual(cookie?.domain, "127.0.0.1")
    XCTAssertEqual(cookie?.name, "openagi_token")
    XCTAssertTrue(cookie?.isHTTPOnly == true)
    XCTAssertNil(PhonePairingWindowController.localCookie(ownerToken: nil))
  }

  func testMainNavigationDoesNotForwardMacCredential() {
    var request = URLRequest(url: URL(string: "https://user:password@main.example/phone-pairing")!)
    request.setValue("Bearer test-local-owner", forHTTPHeaderField: "Authorization")
    let clean = PhonePairingWindowController.cleanNavigation(request)
    XCTAssertEqual(clean?.url?.absoluteString, "https://main.example/phone-pairing")
    XCTAssertNil(clean?.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(PhonePairingWindowController.cleanNavigation(URLRequest(url: URL(string: "file:///tmp/test")!)))
    request.url = URL(string: "http://127.0.0.1:1234/phone-pairing")!
    XCTAssertNil(PhonePairingWindowController.cleanNavigation(request)?.value(forHTTPHeaderField: "Authorization"))
  }
}
