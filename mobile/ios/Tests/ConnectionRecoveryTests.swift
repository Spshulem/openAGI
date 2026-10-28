import XCTest
@preconcurrency import Speech
@testable import OpenAGI

final class ConnectionRecoveryTests: XCTestCase {
    override func tearDown() {
        StubProtocol.handler = nil
        StubProtocol.failure = nil
        super.tearDown()
    }

    private func client() -> DaemonClient {
        StubProtocol.failure = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:resume-test",
                            token: "synthetic-resume-token", session: URLSession(configuration: configuration))
    }

    @MainActor func testPermissionCallbackCanResumeFromTheSystemBackgroundQueue() async {
        let authorized = await ChatDictation.speechAuthorization { reply in
            DispatchQueue.global().async { reply(.authorized) }
        }
        XCTAssertEqual(authorized, .authorized)
        let denied = await ChatDictation.speechAuthorization { reply in
            DispatchQueue.global().async { reply(.denied) }
        }
        XCTAssertEqual(denied, .denied)
    }

    @MainActor func testSavedEnrollmentReconnectsWithoutPairingOrWaitingForOfflineImport() async throws {
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/nodes/heartbeat")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:resume-test")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        var operations: [String] = []
        try await SavedServerReconnect.restore(client: client(), persist: { operations.append("save") }, activate: { operations.append("activate") })
        XCTAssertEqual(operations, ["save", "activate"])
    }

    @MainActor func testRejectedEnrollmentDoesNotOverwriteOrActivateTheSavedCredential() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        var changed = false
        do {
            try await SavedServerReconnect.restore(client: client(), persist: { changed = true }, activate: { changed = true })
            XCTFail("Rejected enrollment must not activate")
        } catch { XCTAssertEqual(error as? DaemonError, .unauthorized) }
        XCTAssertFalse(changed)
    }

    @MainActor func testKeychainFailureLeavesTheCurrentAgentAttached() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        var activated = false
        do {
            try await SavedServerReconnect.restore(client: client(), persist: { throw CredentialsError.keychain(-25308) }, activate: { activated = true })
            XCTFail("Storage failure must not detach the current agent")
        } catch { XCTAssertEqual(error as? CredentialsError, .keychain(-25308)) }
        XCTAssertFalse(activated)
    }

    func testOldDashboardHTMLMeansUnsupportedCatalogRatherThanExpiredPairing() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html"])!, Data("<!doctype html><html>Dashboard</html>".utf8))
        }
        do { _ = try await client().conversations(); XCTFail("HTML is not a conversation catalog") }
        catch { XCTAssertEqual(error as? DaemonError, .notFound) }
    }

    func testSavedPairingErrorsDistinguishAuthorizationFromAnOfflineNetwork() {
        let server = URL(string: "http://agent.example.ts.net:43210")!
        let authorization = ServerConnectionGuidance.savedPairingFailure(DaemonError.unauthorized, server: server)
        XCTAssertTrue(authorization.contains("server responded"))
        XCTAssertTrue(authorization.contains("saved pairing"))
        let offline = ServerConnectionGuidance.savedPairingFailure(DaemonError.transport(URLError(.cannotFindHost)), server: server)
        XCTAssertTrue(offline.contains("resolve"))
        XCTAssertTrue(offline.contains("No new code"))
    }
}
