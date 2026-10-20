import XCTest
@testable import OpenAGI

final class PhoneModelSetupTests: XCTestCase {
    private func client() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(server: URL(string: "http://127.0.0.1:43210")!, nodeID: "mobile:test",
                            token: "test-token", session: URLSession(configuration: config))
    }

    override func tearDown() {
        StubProtocol.handler = nil
        StubProtocol.failure = nil
        super.tearDown()
    }

    func testLocalChoicePersistsBeforeTestingEvenWithCloudKeysSaved() async throws {
        nonisolated(unsafe) var paths: [String] = []
        StubProtocol.handler = { request in
            paths.append(request.url!.path)
            XCTAssertEqual(request.httpMethod, "POST")
            let json = request.url!.path == "/settings/models"
                ? #"{"preference":"on-device","active":{"provider":"on-device"},"providers":{"anthropic":{"configured":true},"openai":{"configured":true},"onDevice":{"available":true}}}"#
                : #"{"ok":true,"model":"apple-foundation-models","text":"OK"}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        try await PhoneModelSetup.useLocal(client: client(), availability: .available)
        XCTAssertEqual(paths, ["/settings/models", "/settings/models/test"])
    }

    func testUnavailableStatesNeverCompleteLocalSetupOrChangeTheProvider() async {
        StubProtocol.handler = { request in
            XCTFail("Unavailable model must not send a selection or test")
            return (HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!, Data())
        }
        for status in [OnDeviceModelStatus.downloading, .notEnabled, .unsupported] {
            do {
                try await PhoneModelSetup.useLocal(client: client(), availability: status)
                XCTFail("Must not complete setup for \(status)")
            } catch PhoneModelSetup.Failure.unavailable {} catch { XCTFail("Unexpected error: \(error)") }
        }
    }

    func testFailedLocalRoundTripDoesNotCompleteSetup() async {
        StubProtocol.handler = { request in
            let json = request.url!.path == "/settings/models"
                ? #"{"preference":"on-device","active":{"provider":"on-device"},"providers":{"anthropic":{"configured":false},"openai":{"configured":false}}}"#
                : #"{"ok":false,"message":"Model is still downloading"}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        do {
            try await PhoneModelSetup.useLocal(client: client(), availability: .available)
            XCTFail("A failed model must not complete setup")
        } catch PhoneModelSetup.Failure.testFailed(let message) {
            XCTAssertEqual(message, "Model is still downloading")
        } catch { XCTFail("Unexpected error: \(error)") }
    }
}
