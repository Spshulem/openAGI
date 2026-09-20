import XCTest
@testable import OpenAGI

// Regression coverage for the live Task 16 end-to-end pairing failure: the
// app's PairingView reported "Could not save credentials to the keychain"
// on a real simulator run because Credentials.save() asked for
// kSecAttrAccessGroup: "sh.openagi.mobile" (no Team ID prefix), which never
// matches this project's actual entitled groups — the project builds with
// CODE_SIGNING_ALLOWED: NO (project.yml), so the installed app carries an
// EMPTY entitlements dict (verified live with
// `codesign -d --entitlements :- <installed .app>`), and even a properly
// signed build embeds "$(AppIdentifierPrefix)sh.openagi.mobile", never the
// bare string the code asked for. Either way, SecItemAdd rejected the
// explicit group.
//
// This test runs inside the real xctest host process on the simulator, so
// it exercises the real Security framework under this project's actual,
// committed signing configuration — not a mock. It is the deterministic
// substitute for a live simulator pairing run, which this task also
// performed by hand (see mobile/README.md and the Task 16 report) but which
// cannot be asserted on reliably here because it depends on interactive UI.
final class CredentialsTests: XCTestCase {
    override func tearDown() {
        Credentials.clear()
        super.tearDown()
    }

    func testSaveThenLoadRoundTripsThroughTheRealKeychain() throws {
        let server = URL(string: "http://192.168.1.110:43299")!
        let credentials = Credentials(server: server, nodeID: "mobile:test-node", token: "test-token-value")

        // This is the exact call PairingView.pair() makes. If it throws,
        // that IS the "Could not save credentials to the keychain" failure
        // reproduced deterministically.
        try credentials.save()

        let loaded = Credentials.load()
        XCTAssertEqual(loaded?.server, server)
        XCTAssertEqual(loaded?.nodeID, "mobile:test-node")
        XCTAssertEqual(loaded?.token, "test-token-value")
    }

    func testClearRemovesASavedCredential() throws {
        let credentials = Credentials(server: URL(string: "http://192.168.1.110:43299")!, nodeID: "mobile:test-node", token: "test-token-value")
        try credentials.save()
        XCTAssertNotNil(Credentials.load())

        Credentials.clear()
        XCTAssertNil(Credentials.load())
    }
}
