import XCTest
@testable import OpenAGI

private final class QuietBrowser: NetServiceBrowser {
    override func searchForServices(ofType type: String, inDomain domain: String) {}
    override func stop() {}
}

final class ServerDiscoveryTests: XCTestCase {
    @MainActor
    func testPermissionFailureSurvivesSavedAddressCheckCompletionAndAllowsRetry() async {
        let browser = QuietBrowser()
        let discovery = ServerDiscovery(makeBrowser: { browser }, check: { _ in true }, searchWindow: .zero)
        let main = URL(string: "http://main.tail1234.ts.net:43210")!
        discovery.start(addresses: [main])
        discovery.netServiceBrowser(browser, didNotSearch: ["NSNetServicesErrorCode": -72008])
        XCTAssertFalse(discovery.searching)
        await discovery.search?.value
        XCTAssertTrue(discovery.note?.contains("Local Network") == true)
        XCTAssertFalse(discovery.note?.contains("No servers found") == true)
        XCTAssertEqual(discovery.servers.first?.address, main)
        XCTAssertEqual(discovery.servers.first?.reachable, true)
        discovery.start(addresses: [main])
        await discovery.search?.value
        XCTAssertFalse(discovery.note?.contains("Local Network") == true, "Retry clears the old browser error")
        discovery.stop()
    }

    @MainActor
    func testUnreachableSavedServerRemainsVisibleInsteadOfAnEmptySearchResult() async {
        let discovery = ServerDiscovery(makeBrowser: { QuietBrowser() }, check: { _ in false }, searchWindow: .zero)
        discovery.start(addresses: [URL(string: "http://main.tail1234.ts.net:43210")!])
        await discovery.search?.value
        XCTAssertEqual(discovery.servers.count, 1)
        XCTAssertEqual(discovery.servers.first?.reachable, false)
        XCTAssertFalse(discovery.searching)
        discovery.stop()
    }
    func testTailscaleNameCanBePastedWithoutSchemeOrPort() {
        XCTAssertEqual(TailscaleServerAddress.parse(" main.tail1234.ts.net ")?.absoluteString,
                       "http://main.tail1234.ts.net:43210")
        XCTAssertEqual(TailscaleServerAddress.parse("https://main.tail1234.ts.net:443/setup")?.path, "")
        XCTAssertNil(TailscaleServerAddress.parse("http://user:password@main.tail1234.ts.net"))
        XCTAssertEqual(TailscaleServerAddress.parse("https://main.tail1234.ts.net:8443")?.absoluteString,
                       "https://main.tail1234.ts.net:8443")
    }

    func testPairingFailuresIdentifyTheAttemptedEndpointAndNetworkRecovery() {
        let server = URL(string: "https://main.tail1234.ts.net:8443")!
        let dns = PairingConnectionFailure.detail(for: URLError(.cannotFindHost), server: server)
        XCTAssertTrue(dns.contains(server.absoluteString))
        XCTAssertTrue(dns.contains("Tailscale DNS"))
        let connection = PairingConnectionFailure.detail(for: URLError(.cannotConnectToHost), server: server)
        XCTAssertTrue(connection.contains("scheme and port"))
        XCTAssertTrue(connection.contains("turn its connection on"))
        let tls = PairingConnectionFailure.detail(for: URLError(.serverCertificateUntrusted), server: server)
        XCTAssertTrue(tls.contains("certificate"))
        XCTAssertFalse(tls.contains("turn its connection on"))
        let lan = PairingConnectionFailure.detail(for: URLError(.notConnectedToInternet), server: URL(string: "http://agent.local:43210")!)
        XCTAssertTrue(lan.contains("Local Network"))
        XCTAssertFalse(lan.contains("Tailscale"))
    }

    func testConnectionGuidanceMatchesTheSelectedNetwork() {
        for address in ["https://main.tail1234.ts.net:8443", "http://MAIN.tail1234.ts.net.:43210", "http://100.64.0.10:43210"] {
            let server = URL(string: address)!
            XCTAssertTrue(ServerConnectionGuidance.requiresTailscale(server))
            XCTAssertTrue(ServerConnectionGuidance.recovery(for: server).contains("connected on the server"))
        }
        for address in ["http://agent.local:43210", "https://192.168.1.20:8443"] {
            let server = URL(string: address)!
            XCTAssertFalse(ServerConnectionGuidance.requiresTailscale(server))
            XCTAssertTrue(ServerConnectionGuidance.recovery(for: server).contains("Local Network"))
        }
        let publicServer = URL(string: "https://agent.example.com")!
        XCTAssertFalse(ServerConnectionGuidance.requiresTailscale(publicServer))
        let recovery = PairingConnectionFailure.detail(for: URLError(.cannotConnectToHost), server: publicServer)
        XCTAssertTrue(recovery.contains("internet connection"))
        XCTAssertTrue(recovery.contains("not required for a public HTTPS server"))
        XCTAssertFalse(recovery.contains("Local Network"))
    }

    @MainActor
    func testSavedTailscaleIPResolvesBeforeHealthCheckInsteadOfDisappearing() async {
        let raw = URL(string: "http://100.64.0.10:43210")!
        let dns = URL(string: "http://main.tail1234.ts.net:43210")!
        let discovery = ServerDiscovery(makeBrowser: { QuietBrowser() }, check: { $0 == dns },
                                        resolveAddress: { await TailscaleServerAddress.resolve($0, lookup: { _ in "main.tail1234.ts.net." }) },
                                        searchWindow: .zero)
        discovery.start(addresses: [raw])
        await discovery.search?.value
        XCTAssertEqual(discovery.servers.map(\.address), [dns])
        XCTAssertEqual(discovery.servers.first?.reachable, true)
    }

    @MainActor
    func testUnavailableTailscaleDNSKeepsSavedIPVisible() async {
        let raw = URL(string: "http://100.64.0.10:43210")!
        let discovery = ServerDiscovery(makeBrowser: { QuietBrowser() }, check: { _ in XCTFail("Do not probe a blocked raw IP"); return false },
                                        resolveAddress: { _ in nil }, searchWindow: .zero)
        discovery.start(addresses: [raw])
        await discovery.search?.value
        XCTAssertEqual(discovery.servers.first?.address, raw)
        XCTAssertEqual(discovery.servers.first?.reachable, false)
    }

    func testReverseDNSCannotEnableCleartextOutsideTailnet() async {
        let result = await TailscaleServerAddress.resolve(URL(string: "http://100.64.0.10:43210")!, lookup: { _ in "untrusted.example" })
        XCTAssertNil(result)
    }

}
