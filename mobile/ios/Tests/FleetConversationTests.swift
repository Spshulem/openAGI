import XCTest
@testable import OpenAGI

final class FleetConversationTests: XCTestCase {
    private func client() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(server: URL(string: "http://mac.tail1234.ts.net:43210")!,
                            nodeID: "mobile:abc", token: String(repeating: "a", count: 43),
                            session: URLSession(configuration: config))
    }

    func testReadsTheSelectedThreadWithExistingPhoneAuthentication() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             Data(#"{"thread":{"key":"codex:chosen","conversation":{"messages":[{"id":"1","role":"user","text":"Why is it blocked?","at":"2026-10-26T10:00:00Z"},{"id":"2","role":"assistant","text":"Here is the context.","at":""}],"truncated":true,"unavailableReason":null}}}"#.utf8))
        }
        let detail = try await client().fleetThreadDetail(key: "codex:chosen")
        XCTAssertEqual(detail.conversation?.messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(detail.conversation?.messages.last?.text, "Here is the context.")
        XCTAssertNil(detail.conversation?.messages.last?.at)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/fleet/api/threads/codex:chosen")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:abc")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + String(repeating: "a", count: 43))
    }

    func testRejectsAResponseForAnotherThreadAndPathsOutsideTheThreadRoute() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             Data(#"{"thread":{"key":"codex:other"}}"#.utf8))
        }
        for key in ["codex:chosen", "codex:../other", "codex:a?query=other", "unrecognized:a"] {
            do { _ = try await client().fleetThreadDetail(key: key); XCTFail("Must reject \(key)") }
            catch let error as DaemonError { XCTAssertEqual(error, .malformedResponse) }
            catch { XCTFail("Unexpected error: \(error)") }
        }
    }

    func testOlderServerDetailStillDecodesItsLastMessage() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             Data(#"{"thread":{"key":"codex:chosen","lastAgentMessage":{"text":"Last known context"}}}"#.utf8))
        }
        let detail = try await client().fleetThreadDetail(key: "codex:chosen")
        XCTAssertNil(detail.conversation)
        XCTAssertEqual(detail.lastAgentMessage?.text, "Last known context")
    }
}
