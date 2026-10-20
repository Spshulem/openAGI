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
        let skillsData = try await EmbeddedDaemon.shared.ownerRaw(path: "/skills", method: "GET")
        let skills = try XCTUnwrap(JSONSerialization.jsonObject(with: skillsData) as? [[String: Any]])
        let names = Set(skills.compactMap { $0["name"] as? String })
        XCTAssertTrue(names.contains("morning-brief"), "Built-in skills must be bundled with the daemon")
        XCTAssertTrue(names.contains("recap"))
        let port = try XCTUnwrap(EmbeddedDaemon.shared.port)
        let secrets = try XCTUnwrap(EmbeddedSecrets.load())
        let bridge = DeviceModelBridge()
        await bridge.connect(port: port, ownerToken: secrets.ownerToken, backend: SmokeModel())
        do {
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            // A saved cloud key must never override the person's local choice.
            _ = try await client.updateModelSettings(.init(openaiKey: "synthetic-test-key"))
            try await PhoneModelSetup.useLocal(client: client, availability: .available)
            let settings = try await client.modelSettings()
            XCTAssertEqual(settings.preference, "on-device")
            XCTAssertEqual(settings.active.provider, "on-device")
            let result = try await EmbeddedDaemon.shared.ownerRequest(path: "/settings/models/test", body: [:])
            XCTAssertEqual(result["ok"] as? Bool, true)
            XCTAssertEqual(result["text"] as? String, "Native model bridge works")
            let title = "Synthetic local task \(UUID().uuidString)"
            let stream = try await client.sendMessageStreaming(text: "Test local task: \(title)", thread: .agent)
            for try await _ in stream {}
            let tasks = try await client.tasks()
            XCTAssertTrue(tasks.contains { $0.title == title }, "The native bridge must run the daemon's real task tool")
            let history = try await client.conversationMessages(thread: .agent)
            XCTAssertTrue(history.messages.contains { $0.text.contains(title) }, "Local chat must be readable after the turn")
            _ = try await client.updateModelSettings(.init(clear: ["openaiKey"]))
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
        if let message = request.messages.last(where: { $0.role == "user" }),
           let marker = message.content.range(of: "Test local task: ", options: .backwards),
           request.messages.last?.role != "tool" {
            return .toolCall(.init(name: "add_task", arguments: .object([
                "title": .string(String(message.content[marker.upperBound...])),
                "queue": .string("user"), "bucket": .string("today")
            ])))
        }
        onDelta("Native model bridge works")
        return .text("Native model bridge works")
    }
}
