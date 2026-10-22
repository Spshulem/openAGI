import Foundation
import XCTest
@testable import OpenAGI

final class FallbackTransportTests: XCTestCase {
    private let lines = [FallbackLine(role: "user", text: "Help me plan tomorrow")]

    func testProviderKeysUseOnlyFixedHTTPSDestinations() throws {
        let expected: [FallbackProvider: String] = [.openAI: "api.openai.com", .anthropic: "api.anthropic.com", .openRouter: "openrouter.ai", .gemini: "generativelanguage.googleapis.com"]
        for (provider, host) in expected {
            let request = try FallbackTransport.request(provider: provider, model: provider.defaultModel, key: "unit-test-credential", lines: lines)
            XCTAssertEqual(request.url?.scheme, "https")
            XCTAssertEqual(request.url?.host, host)
            XCTAssertNil(request.url?.query)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"))
            let body = String(data: try XCTUnwrap(request.httpBody), encoding: .utf8)!
            XCTAssertFalse(body.contains("unit-test-credential"))
            XCTAssertTrue(body.contains("Help me plan tomorrow"))
        }
    }

    func testOpenAIOptsOutOfResponseStorage() throws {
        let request = try FallbackTransport.request(provider: .openAI, model: "gpt-5-mini", key: "unit-test-credential", lines: lines)
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as! [String: Any]
        XCTAssertEqual(body["store"] as? Bool, false)
    }

    func testLocalModeNeverBuildsNetworkRequestAndGeminiRejectsPaths() {
        XCTAssertThrowsError(try FallbackTransport.request(provider: .local, model: "local", key: "unit-test-credential", lines: lines))
        for model in ["../outside", "evil.example/a", "gemini?key=other"] {
            XCTAssertThrowsError(try FallbackTransport.request(provider: .gemini, model: model, key: "unit-test-credential", lines: lines))
        }
    }

    func testDecodeProviderRepliesAndRejectEmptyOrRefusedReply() throws {
        let samples: [(FallbackProvider, String)] = [
            (.openAI, #"{"output":[{"content":[{"type":"output_text","text":"Hello"}]}]}"#),
            (.anthropic, #"{"content":[{"type":"text","text":"Hello"}]}"#),
            (.openRouter, #"{"choices":[{"message":{"content":"Hello"}}]}"#),
            (.gemini, #"{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}"#)
        ]
        for (provider, json) in samples {
            XCTAssertEqual(try FallbackTransport.decode(Data(json.utf8), provider: provider), "Hello")
            XCTAssertThrowsError(try FallbackTransport.decode(Data("{}".utf8), provider: provider))
        }
    }
}
