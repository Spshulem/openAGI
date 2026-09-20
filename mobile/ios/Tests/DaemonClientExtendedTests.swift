import XCTest
@testable import OpenAGI

// NOTE on what this file does NOT cover: neither a synchronous
// `URLProtocol` stub (`StubProtocol`, from DaemonClientTests.swift) nor a
// deferred-delivery variant got a single byte through
// `URLSession.bytes(for:)`'s `.lines` sequence in this SDK/simulator, even
// though the identical response works fine through `data(for:)` everywhere
// else in this suite -- an environment limitation, not evidence the parsing
// itself is untested. `eventStream()`/`sendMessageStreaming()`'s actual
// frame-by-frame parsing (`SSEFrameParser`, `DaemonEvent.from`,
// `ChatEvent.decode`) is exhaustively covered by SSEFrameParserTests and
// ChatEventTests instead, both pure and needing no URLSession at all. What
// this file covers for the two streaming methods is what the stub CAN
// verify reliably: the exact request each one sends.

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
    func testEventStreamSendsTheExpectedRequest() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
        }
        _ = try await makeClient().eventStream()
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

    // Same limitation as `testEventStreamSendsTheExpectedRequest` above --
    // this covers the request `sendMessageStreaming` sends; the frame
    // decoding it depends on is covered by ChatEventTests instead.
    func testSendMessageStreamingSendsTheExpectedRequest() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data())
        }
        _ = try await makeClient().sendMessageStreaming(text: "hello")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/message")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        let body = try bodyJSON(of: request)
        XCTAssertEqual(body["text"] as? String, "hello")
    }
}
