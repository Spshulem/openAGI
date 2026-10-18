import XCTest
@testable import OpenAGI

// Runs the actual bundled Node daemon and native WebSocket bridge. The
// deterministic backend keeps this independent of Apple Intelligence assets
// (which are unavailable in Simulator).
final class EmbeddedDaemonIntegrationTests: XCTestCase {
    @MainActor
    func testBundledDaemonEnrollsAndUsesNativeModelBridge() async throws {
        try XCTSkipUnless(EmbeddedDaemon.isBundled, "Run scripts/fetch-node-runtime.sh first")
        let credentials = try await EmbeddedDaemon.shared.localCredentials()
        XCTAssertTrue(credentials.isEmbedded)
        let port = try XCTUnwrap(EmbeddedDaemon.shared.port)
        let secrets = try XCTUnwrap(EmbeddedSecrets.load())
        let bridge = DeviceModelBridge()
        await bridge.connect(port: port, ownerToken: secrets.ownerToken, backend: SmokeModel())
        do {
            let result = try await EmbeddedDaemon.shared.ownerRequest(path: "/settings/models/test", body: [:])
            XCTAssertEqual(result["ok"] as? Bool, true)
            XCTAssertEqual(result["text"] as? String, "Native model bridge works")
            await bridge.disconnect()
        } catch {
            await bridge.disconnect()
            throw error
        }
    }
}

private struct SmokeModel: DeviceModelBackend {
    var modelName: String { "integration-test-model" }
    func contextSize() async -> Int { 4096 }
    func generate(_ request: DeviceGenerateRequest,
                  onDelta: @escaping @Sendable (String) -> Void) async throws -> DeviceGenerateResult {
        onDelta("Native model bridge works")
        return .text("Native model bridge works")
    }
}
