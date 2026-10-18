import XCTest
@testable import OpenAGI

final class AppModeTests: XCTestCase {
    func testInterruptedPhoneSetupStartsEmbeddedDaemon() {
        let local = Credentials(server: URL(string: "http://127.0.0.1:12345")!, nodeID: "mobile:local", token: "test-token")
        XCTAssertEqual(AppMode.resolved(credentials: local, storedMode: nil), .onPhone)
        // Also recover when trying the phone agent from an existing pairing.
        XCTAssertEqual(AppMode.resolved(credentials: local, storedMode: .server), .onPhone)
    }

    func testLegacyPairingAndFreshInstallKeepTheirLaunchBehavior() {
        let remote = Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:remote", token: "test-token")
        XCTAssertEqual(AppMode.resolved(credentials: remote, storedMode: nil), .server)
        XCTAssertEqual(AppMode.resolved(credentials: remote, storedMode: .onPhone), .onPhone)
        XCTAssertNil(AppMode.resolved(credentials: nil, storedMode: nil))
        XCTAssertEqual(AppMode.resolved(credentials: nil, storedMode: .server), .server)
    }
}
