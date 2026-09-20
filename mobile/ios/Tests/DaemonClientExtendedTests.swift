import XCTest
@testable import OpenAGI

// Finding from building this phase, left here because it will bite whoever
// touches this file next: `URLSession.AsyncBytes.lines` never yielded a
// single line against either `StubProtocol` or a real daemon connection in
// this SDK/simulator, even though the raw byte sequence underneath it
// delivered every byte correctly in both cases (verified live: `for try
// await _ in bytes` counted the full response; `.lines` produced nothing).
// `DaemonClient` no longer uses `.lines` for this reason -- see its private
// `lines(of:)`, which splits the byte sequence by hand -- which is also
// what makes the stubbed tests below able to assert on parsed frame content
// again rather than request shape alone.

// Extends DaemonClientTests.swift's coverage to every route this phase
// added: tasks CRUD, clarifications, pending actions, and the two SSE
// surfaces (the shared `GET /events` broadcast and the per-message `POST
// /message` stream). Reuses `StubProtocol` from DaemonClientTests.swift --
// same test target, same file-scope visibility.
final class DaemonClientExtendedTests: XCTestCase {
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

    private func bodyJSON(of request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        } ?? request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func fixture(_ name: String) throws -> Data {
        let here = URL(filePath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appending(path: "fixtures/\(name).json"))
    }

    // MARK: - Tasks

    func testTasksSendsTheQueueQueryAndDecodesRecords() async throws {
        let fixture = try fixture("tasks-list")
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, fixture)
        }
        let tasks = try await makeClient().tasks(queue: "user")
        XCTAssertEqual(tasks.first?.title, "Ship the widget")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/tasks")
        XCTAssertEqual(request.url?.query, "queue=user")
    }

    func testCreateTaskSendsTitleAndBucket() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             try! self.fixture("tasks-list"))
        }
        _ = try? await makeClient().createTask(NewTaskInput(title: "Water the plants", bucket: .thisWeek, priority: 70))
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/tasks")
        let body = try bodyJSON(of: request)
        XCTAssertEqual(body["title"] as? String, "Water the plants")
        XCTAssertEqual(body["bucket"] as? String, "this_week")
        XCTAssertEqual(body["priority"] as? Int, 70)
    }

    func testUpdateTaskSendsOnlyTheFieldsThatChanged() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             try! self.fixture("tasks-list"))
        }
        _ = try? await makeClient().updateTask(id: "task_abc", patch: TaskPatch(title: "New title"))
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/tasks/task_abc")
        let body = try bodyJSON(of: request)
        XCTAssertEqual(body.count, 1, "only the changed field should be sent")
        XCTAssertEqual(body["title"] as? String, "New title")
    }

    // `TaskPatch.dueDate` is `Date??`: outer nil means "leave alone", inner
    // nil means "clear it". This pins the clearing path sends JSON `null`,
    // not that the field is omitted.
    func testUpdateTaskCanExplicitlyClearTheDueDate() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
             try! self.fixture("tasks-list"))
        }
        _ = try? await makeClient().updateTask(id: "task_abc", patch: TaskPatch(dueDate: .some(nil)))
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        let body = try bodyJSON(of: request)
        XCTAssertTrue(body.keys.contains("dueDate"))
        XCTAssertTrue(body["dueDate"] is NSNull)
    }

    func testDeleteTaskUsesTheDeleteMethod() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        try await makeClient().deleteTask(id: "task_abc")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/tasks/task_abc")
    }

    func testTaskRouteStatusCodesMapToTheSameTypedErrorsAsEverythingElse() async {
        for (code, expected) in [(401, DaemonError.unauthorized), (404, .notFound), (409, .conflict)] {
            StubProtocol.handler = { request in
                (HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!, Data())
            }
            do {
                try await makeClient().deleteTask(id: "task_abc")
                XCTFail("expected a throw for \(code)")
            } catch let error as DaemonError {
                XCTAssertEqual(error, expected)
            } catch { XCTFail("unexpected \(error)") }
        }
    }

    // MARK: - Clarifications

    func testClarificationsDecodesTheBareArrayTheDaemonReturns() async throws {
        let json = #"[{"id":"clar_1","taskId":"task_1","question":"Done?","context":"","proposedAction":"complete","confidence":null,"sources":[],"status":"pending","answer":null,"answeredAt":null,"createdAt":"2026-09-20T01:00:00.000Z"}]"#
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        let clarifications = try await makeClient().clarifications()
        XCTAssertEqual(clarifications.first?.question, "Done?")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path, "/tasks/clarifications")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.query, "status=pending")
    }

    func testAnswerClarificationSendsExactlyOneOfTheDaemonsValidValues() async throws {
        let json = #"{"clarification":{"id":"clar_1","taskId":"task_1","question":"Done?","context":"","proposedAction":"complete","confidence":null,"sources":[],"status":"answered","answer":"yes","answeredAt":"2026-09-20T01:00:00.000Z","createdAt":"2026-09-20T01:00:00.000Z"},"task":null}"#
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        _ = try await makeClient().answerClarification(id: "clar_1", answer: .yes)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/tasks/clarifications/clar_1/answer")
        let body = try bodyJSON(of: request)
        XCTAssertEqual(body["answer"] as? String, "yes")
    }

    // MARK: - Pending actions

    // mobile/PROTOCOL.md §11 describes this fixture as the empty-list shape;
    // the committed file actually carries one populated action. This test
    // follows the real file -- see the phase report.
    func testPendingActionsDecodesTheActionsArray() async throws {
        let fixture = try fixture("pending-actions")
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, fixture)
        }
        let actions = try await makeClient().pendingActions()
        XCTAssertEqual(actions.first?.toolName, "send_email")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.query, "status=pending")
    }

    func testApprovePendingActionPostsWithNoBody() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"ok":true,"result":{}}"#.utf8))
        }
        let outcome = try await makeClient().approvePendingAction(id: "act_1")
        XCTAssertTrue(outcome.ok)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/pending-actions/act_1/approve")
    }

    func testDenyPendingActionSendsTheOptionalReason() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"id":"act_1","status":"denied"}"#.utf8))
        }
        _ = try await makeClient().denyPendingAction(id: "act_1", reason: "not now")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        let body = try bodyJSON(of: request)
        XCTAssertEqual(body["reason"] as? String, "not now")
    }

    func testDenyPendingActionOmitsReasonWhenNil() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"id":"act_1","status":"denied"}"#.utf8))
        }
        _ = try await makeClient().denyPendingAction(id: "act_1", reason: nil)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        let body = try bodyJSON(of: request)
        XCTAssertNil(body["reason"])
    }

    // MARK: - SSE: GET /events

    // NOTE: neither `StubProtocol` (synchronous delivery) nor
    // `AsyncStubProtocol` (deferred delivery) got a single byte through
    // `URLSession.bytes(for:)`'s `.lines` sequence in this SDK/simulator --
    // both produced zero lines even though the identical response works
    // fine through `data(for:)` everywhere else in this suite. The actual
    // frame-by-frame parsing this method depends on (`SSEFrameParser`,
    // `DaemonEvent.from`) is exhaustively covered by SSEFrameParserTests
    // instead, which is pure and needs no URLSession at all. This test
    // covers what the stub CAN verify reliably: the request this method
    // sends before it ever touches the byte stream.
    func testEventStreamParsesEveryFrameFromTheStubbedConnection() async throws {
        let raw = "event: hello\ndata: {}\n\nevent: task-updated\ndata: {\"op\":\"create\"}\n\n: ping\n\nevent: pending-action\ndata: {}\n\n"
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(raw.utf8))
        }
        let stream = try await makeClient().eventStream()
        var received: [DaemonEvent] = []
        for try await event in stream { received.append(event) }
        XCTAssertEqual(received, [.hello, .taskUpdated, .pendingAction])
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/events")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(String(repeating: "a", count: 43))")
    }

    func testEventStreamSurfacesUnauthorizedBeforeStreamingAnything() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!, Data())
        }
        do {
            _ = try await makeClient().eventStream()
            XCTFail("expected a throw")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .unauthorized)
        } catch { XCTFail("unexpected \(error)") }
    }

    // MARK: - SSE: POST /message

    func testSendMessageStreamingSendsTextAndParsesDeltaAndFinalFrames() async throws {
        let raw = "event: status\ndata: {\"stage\":\"thinking\",\"at\":\"x\"}\n\nevent: delta\ndata: {\"text\":\"Hi\",\"reset\":false}\n\nevent: final\ndata: {\"reply\":\"Hi there\"}\n\n"
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(raw.utf8))
        }
        let stream = try await makeClient().sendMessageStreaming(text: "hello")
        var events: [ChatEvent] = []
        for try await event in stream { events.append(event) }
        XCTAssertEqual(events.count, 3)
        guard case .final(let finalFrame) = events.last else { return XCTFail("expected a final frame last") }
        XCTAssertEqual(finalFrame.reply, "Hi there")

        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/message")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        let body = try bodyJSON(of: request)
        XCTAssertEqual(body["text"] as? String, "hello")
    }

    // A bare test daemon (no agent host configured) 503s `POST /message`
    // BEFORE any SSE stream starts -- src/hosted-interface.js's `if
    // (!channels) return sendJson(res, 503, { error: "agent-host-disabled"
    // })`. This must surface as its own typed error, not the generic
    // `.server(503)` that used to reach ChatView as "Can't reach OpenAGI" --
    // indistinguishable from an actually-down daemon.
    func testSendMessageStreamingSurfacesAgentHostDisabledFrom503Body() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!,
             Data(#"{"error":"agent-host-disabled"}"#.utf8))
        }
        do {
            _ = try await makeClient().sendMessageStreaming(text: "hello")
            XCTFail("expected a throw")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .agentHostDisabled)
        } catch { XCTFail("unexpected \(error)") }
    }

    // A 503 for any other reason (an actual server fault) must not be
    // misreported as "no agent host" -- only the specific body maps there.
    func testSendMessageStreamingTreatsOtherServiceUnavailableBodiesGenerically() async {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!,
             Data(#"{"error":"database-unavailable"}"#.utf8))
        }
        do {
            _ = try await makeClient().sendMessageStreaming(text: "hello")
            XCTFail("expected a throw")
        } catch let error as DaemonError {
            XCTAssertEqual(error, .server(503))
        } catch { XCTFail("unexpected \(error)") }
    }
}
