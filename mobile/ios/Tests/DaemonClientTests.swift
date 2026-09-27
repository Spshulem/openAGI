import XCTest
@testable import OpenAGI

// A URLProtocol stub keeps these tests hermetic: no daemon, no network, but the
// exact request the daemon would receive is asserted.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
    // Set to simulate a transport-level failure (dropped connection, DNS,
    // TLS, etc.) instead of returning a response. Tests that set this must
    // reset it to nil afterward so it doesn't leak into later tests.
    nonisolated(unsafe) static var failure: Error?
    nonisolated(unsafe) static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        if let failure = Self.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        let (response, data) = Self.handler!(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class DaemonClientTests: XCTestCase {
    private func makeClient() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(
            server: URL(string: "http://mac.tail1234.ts.net:43210")!,
            nodeID: "mobile:abc",
            token: String(repeating: "a", count: 43),
            session: URLSession(configuration: config)
        )
    }

    // URLSession hands an intercepted request's body to URLProtocol as a
    // stream, not as `httpBody` directly — this drains it so a test can
    // assert on the exact serialized bytes.
    private func bodyData(of request: URLRequest) throws -> Data {
        try XCTUnwrap(request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        })
    }

    func testSummarySendsCredentialsAndDecodes() async throws {
        let fixture = try Data(contentsOf: URL(filePath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "fixtures/summary-populated.json"))
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                             headerFields: ["ETag": "\"abc\""])!, fixture)
        }
        let result = try await makeClient().summary(ifNoneMatch: nil)
        guard case let .fresh(summary, etag) = result else { return XCTFail("expected fresh") }
        XCTAssertEqual(summary.today.first?.title, "Ship the widget")
        XCTAssertEqual(etag, "\"abc\"")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/mobile/summary")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(String(repeating: "a", count: 43))")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:abc")
    }

    func testNotModifiedIsNotAnError() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 304, httpVersion: nil, headerFields: nil)!, Data())
        }
        let result = try await makeClient().summary(ifNoneMatch: "\"abc\"")
        guard case .unchanged = result else { return XCTFail("expected unchanged") }
        XCTAssertEqual(StubProtocol.lastRequest?.value(forHTTPHeaderField: "If-None-Match"), "\"abc\"")
    }

    func testCompleteSendsCompletedViaMobile() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        try await makeClient().complete(taskID: "task_abc")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/tasks/task_abc/complete")
        let body = try bodyData(of: request)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"completedVia":"mobile"}"#)
    }

    func testHeartbeatSendsRoleNode() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{\"ok\":true}".utf8))
        }
        try await makeClient().heartbeat()
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/nodes/heartbeat")
        let body = try bodyData(of: request)
        // Dropping or misspelling "role" here compiles fine and 400s against a
        // real daemon (POST /nodes/heartbeat requires role to be exactly "node")
        // — that regression already shipped once in this plan's own text.
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"nodeId":"mobile:abc","role":"node"}"#)
    }

    func testStatusCodesMapToTypedErrors() async {
        for (code, expected) in [(401, DaemonError.unauthorized), (404, .notFound), (409, .conflict)] {
            StubProtocol.handler = { request in
                (HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!, Data())
            }
            do {
                try await makeClient().complete(taskID: "task_abc")
                XCTFail("expected a throw for \(code)")
            } catch let error as DaemonError {
                XCTAssertEqual(error, expected)
            } catch { XCTFail("unexpected \(error)") }
        }
    }

    func testAnUnreachableHostIsRefusedBeforeAnyRequest() async {
        let client = DaemonClient(server: URL(string: "http://evil.example.com")!,
                                  nodeID: "mobile:abc", token: String(repeating: "a", count: 43))
        do {
            _ = try await client.summary(ifNoneMatch: nil)
            XCTFail("expected a refusal")
        } catch let error as DaemonError {
            guard case .unreachableHost = error else { return XCTFail("wrong error \(error)") }
        } catch { XCTFail("unexpected \(error)") }
    }

    func testTransportFailureSurfacesAsTransportError() async {
        struct StubNetworkFailure: Error {}
        StubProtocol.failure = StubNetworkFailure()
        defer { StubProtocol.failure = nil }
        do {
            _ = try await makeClient().summary(ifNoneMatch: nil)
            XCTFail("expected a throw")
        } catch let error as DaemonError {
            guard case .transport = error else { return XCTFail("wrong error \(error)") }
        } catch { XCTFail("unexpected \(error)") }
    }
}
