import XCTest
@testable import OpenAGI

final class PhonePairingTests: XCTestCase {
  func testBundleAllowsLocalDaemonAndPairedIPConnectionsWithoutDisablingATS() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: root.appendingPathComponent("Resources/Info.plist"))
    let info = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    let ats = try XCTUnwrap(info["NSAppTransportSecurity"] as? [String: Any])
    XCTAssertEqual(ats["NSAllowsLocalNetworking"] as? Bool, true)
    XCTAssertNotEqual(ats["NSAllowsArbitraryLoads"] as? Bool, true)
    XCTAssertNotEqual(ats["NSAllowsArbitraryLoadsInWebContent"] as? Bool, true)
    XCTAssertFalse((info["NSLocalNetworkUsageDescription"] as? String ?? "").isEmpty)
  }

  func testTransportAndResponseFailuresHaveDistinctRecoveryMessages() {
    let blocked = PhonePairingError.message(for: URLError(.appTransportSecurityRequiresSecureConnection))
    XCTAssertTrue(blocked.contains("macOS blocked"))
    XCTAssertFalse(blocked.contains("Wi-Fi"))
    XCTAssertTrue(PhonePairingError.message(for: URLError(.serverCertificateUntrusted)).contains("certificate"))
    XCTAssertTrue(PhonePairingError.message(for: URLError(.cannotFindHost)).contains("address"))
    XCTAssertEqual(PhonePairingError.message(for: DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "fixture"))),
      PhonePairingError.invalidCode.localizedDescription)
  }

  func testLocalOwnerIsOnlyUsedWithoutAMain() throws {
    let connection = try PhonePairingConnection.resolve(localOwnerToken: "local-owner", nodeConfig: nil,
      savedMainURL: "https://other.example", savedMainToken: "other-owner")
    XCTAssertEqual(connection.origin.absoluteString, "http://127.0.0.1:43210")
    XCTAssertEqual(connection.request().value(forHTTPHeaderField: "Authorization"), "Bearer local-owner")
  }

  func testWorkerUsesOnlyMatchingSavedMainOwnerAndPostsMobileCode() throws {
    let config = Data(#"{"remote":"https://main.example","nodeToken":"operational","ownerProxyToken":"workspace"}"#.utf8)
    let connection = try PhonePairingConnection.resolve(localOwnerToken: "local-owner", nodeConfig: config,
      savedMainURL: "https://main.example:443/", savedMainToken: "main-owner")
    let request = connection.request()
    XCTAssertEqual(request.url?.absoluteString, "https://main.example/nodes/enrollment-code")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer main-owner")
    XCTAssertEqual(request.httpBody, Data(#"{"platform":"mobile"}"#.utf8))
    let unmatched = try PhonePairingConnection.resolve(localOwnerToken: "local-owner", nodeConfig: config,
      savedMainURL: "https://another.example", savedMainToken: "wrong-owner")
    XCTAssertNil(unmatched.request().value(forHTTPHeaderField: "Authorization"))
    let wrongPort = try PhonePairingConnection.resolve(localOwnerToken: "local-owner", nodeConfig: config,
      savedMainURL: "https://main.example:444", savedMainToken: "wrong-owner")
    XCTAssertNil(wrongPort.ownerToken)
  }

  func testUntrustedOriginsAreRejectedAndCookiesStayOnExactHost() throws {
    for input in ["file:///tmp/secret", "https://owner:secret@main.example", "https://main.example/?token=secret", "https://main.example/path", "https://main.example/#fragment"] {
      XCTAssertNil(PhonePairingConnection.origin(input))
    }
    let connection = PhonePairingConnection(origin: URL(string: "https://main.example")!, ownerToken: nil)
    func cookie(_ domain: String) -> HTTPCookie {
      HTTPCookie(properties: [.domain: domain, .path: "/", .name: "openagi_token", .value: "session"])!
    }
    XCTAssertNil(connection.request(cookies: [cookie("other.example"), cookie(".example")]).value(forHTTPHeaderField: "Cookie"))
    XCTAssertEqual(connection.request(cookies: [cookie("main.example")]).value(forHTTPHeaderField: "Cookie"), "openagi_token=session")
    XCTAssertThrowsError(try PhonePairingConnection.resolve(localOwnerToken: "local", nodeConfig: Data("broken".utf8), savedMainURL: "", savedMainToken: nil))
  }

  func testCodeValidatesExpiryAndPrefersPhoneReachableAddress() throws {
    let main = PhonePairingConnection(origin: URL(string: "https://main.example")!, ownerToken: nil)
    let data = Data(#"{"code":"123456","expiresAt":"2030-01-01T00:00:00.123Z","publicUrl":"http://127.0.0.1:43210"}"#.utf8)
    let code = try PhonePairingCode.decode(data, connection: main, now: Date(timeIntervalSince1970: 0))
    XCTAssertEqual(code.code, "123456")
    XCTAssertEqual(code.server, main.origin)
    XCTAssertThrowsError(try PhonePairingCode.decode(data, connection: main, now: .distantFuture))
    let local = PhonePairingConnection(origin: URL(string: "http://127.0.0.1:43210")!, ownerToken: nil)
    XCTAssertThrowsError(try PhonePairingCode.decode(data, connection: local, now: Date(timeIntervalSince1970: 0)))
  }
}
