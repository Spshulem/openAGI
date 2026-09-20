import XCTest
@testable import OpenAGI

final class HostAllowlistTests: XCTestCase {
    func testTailnetAndLanCleartextAreAllowed() throws {
        for raw in ["http://mac.tail1234.ts.net:43210",
                    "http://100.101.102.103:43210",
                    "http://192.168.1.20:43210",
                    "http://10.0.0.5:43210",
                    "http://172.16.4.4:43210"] {
            XCTAssertNoThrow(try HostAllowlist.validate(URL(string: raw)!), raw)
        }
    }

    func testPublicCleartextIsRefused() {
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://openagi.example.com")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://8.8.8.8:43210")!))
        // 172.32 is outside the private range even though it looks close.
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://172.32.0.1:43210")!))
    }

    func testHTTPSIsAlwaysAllowed() {
        XCTAssertNoThrow(try HostAllowlist.validate(URL(string: "https://openagi.example.com")!))
    }

    func testNonHTTPSchemesAreRefused() {
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "ftp://mac.ts.net")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "file:///etc/passwd")!))
    }

    // Self-review addition: the plan calls out these exact near-misses as the
    // ones worth pinning directly, since Android's allowlist must agree with
    // this one boundary-for-boundary even though the two share no code.
    func testCIDRBoundaryNearMissesAreRefused() {
        // 172.16-31 is private; 172.15 and 172.32 sit just outside it.
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://172.15.255.255:43210")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://172.32.0.1:43210")!))
        // 100.64-127 is Tailscale CGNAT; 100.63 and 100.128 sit just outside it.
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://100.63.255.255:43210")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://100.128.0.1:43210")!))
        // 192.168/16 is private; 192.167 and 192.169 are not — this is not "any 192.x".
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://192.167.1.1:43210")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://192.169.1.1:43210")!))
    }
}
