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
}
