import Observation
import XCTest
import os
@testable import OpenAGI

// Reuses `StubProtocol` from DaemonClientTests.swift (same test target).
@MainActor
final class EventStreamControllerTests: XCTestCase {
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

    // Chat's header reads `isConnected` through AppModel. If the controller
    // is not observable, connecting never invalidates the view and the header
    // stays on "reconnecting" (or "live") until an unrelated re-render.
    func testConnectionChangesNotifyObservers() async throws {
        StubProtocol.failure = nil
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             Data("event: hello\ndata: {}\n\n".utf8))
        }
        let controller = EventStreamController(client: makeClient())
        let notified = OSAllocatedUnfairLock(initialState: false)
        withObservationTracking {
            _ = controller.isConnected
        } onChange: {
            notified.withLock { $0 = true }
        }

        var events = controller.events().makeAsyncIterator()
        let first = await events.next()
        controller.stop()

        XCTAssertEqual(first, .hello)
        XCTAssertTrue(notified.withLock { $0 }, "connecting must notify observers of isConnected")
    }
}
