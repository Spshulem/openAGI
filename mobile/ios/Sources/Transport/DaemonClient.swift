import Foundation

public enum DaemonError: Error {
    case unreachableHost(String)
    case unauthorized
    case notFound
    case conflict
    case server(Int)
    case malformedResponse
    case transport(Error)
    // `POST /message` (and `/setup/test`) 503 with `{"error":"agent-host-
    // disabled"}` when the daemon has no model provider configured yet
    // (src/hosted-interface.js). A bare test daemon looks exactly like this,
    // and it is not "the server broke" -- it is a legible, expected state
    // chat's UI must say plainly rather than showing a generic server error.
    case agentHostDisabled
}

// `Error` doesn't conform to `Equatable`, so adding `.transport(Error)` above
// breaks synthesized conformance. Written by hand: every case compares by its
// own stable payload, and `.transport` compares only by case — two transport
// failures are "the same kind of error" for test/UI purposes regardless of
// what the underlying `URLError`/etc. actually was.
extension DaemonError: Equatable {
    public static func == (lhs: DaemonError, rhs: DaemonError) -> Bool {
        switch (lhs, rhs) {
        case let (.unreachableHost(a), .unreachableHost(b)): return a == b
        case (.unauthorized, .unauthorized): return true
        case (.notFound, .notFound): return true
        case (.conflict, .conflict): return true
        case let (.server(a), .server(b)): return a == b
        case (.malformedResponse, .malformedResponse): return true
        case (.transport, .transport): return true
        case (.agentHostDisabled, .agentHostDisabled): return true
        default: return false
        }
    }
}

public enum SummaryResponse: Sendable {
    case unchanged
    case fresh(MobileSummary, etag: String?)
}

public struct Enrollment: Codable, Sendable {
    public struct Node: Codable, Sendable { public let id: String; public let name: String; public let platform: String }
    public let node: Node
    public let nodeToken: String
}

public actor DaemonClient {
    private let server: URL
    private let nodeID: String
    private let token: String
    private let session: URLSession

    public init(server: URL, nodeID: String, token: String, session: URLSession = .shared) {
        self.server = server
        self.nodeID = nodeID
        self.token = token
        self.session = session
    }

    public func summary(ifNoneMatch etag: String?) async throws -> SummaryResponse {
        var request = try authorizedRequest(path: "/mobile/summary", method: "GET")
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, http) = try await perform(request)
        if http.statusCode == 304 { return .unchanged }
        let summary = try Self.decodeJSON(MobileSummary.self, from: data)
        return .fresh(summary, etag: http.value(forHTTPHeaderField: "ETag"))
    }

    public func complete(taskID: String) async throws {
        var request = try authorizedRequest(path: "/tasks/\(taskID)/complete", method: "POST")
        request.httpBody = Data(#"{"completedVia":"mobile"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    public func heartbeat() async throws {
        var request = try authorizedRequest(path: "/nodes/heartbeat", method: "POST")
        // role is required and must be exactly "node". The name is deliberately
        // omitted: the daemon stores the name this node enrolled with and ignores
        // anything the wire claims, so sending one could only ever disagree. Sent
        // as a literal string (like complete()) rather than through JSONEncoder,
        // whose Dictionary-backed encoding has no guaranteed key order — a body a
        // test can assert on byte-for-byte has to be built the same way every time.
        request.httpBody = Data(#"{"nodeId":"\#(nodeID)","role":"node"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    public func revoke() async throws {
        var request = try authorizedRequest(path: "/nodes/revoke", method: "POST")
        request.httpBody = Data(#"{"nodeId":"\#(nodeID)"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    // MARK: - Tasks (mobile/PROTOCOL.md §5, mobile/FEATURES.md's Tasks tab)

    public func tasks(queue: String = "user", bucket: String? = nil, status: String? = nil, limit: Int? = nil) async throws -> [TaskRecord] {
        var items = [URLQueryItem(name: "queue", value: queue)]
        if let bucket { items.append(URLQueryItem(name: "bucket", value: bucket)) }
        if let status { items.append(URLQueryItem(name: "status", value: status)) }
        if let limit { items.append(URLQueryItem(name: "limit", value: String(limit))) }
        let request = try authorizedRequest(path: "/tasks", method: "GET", queryItems: items)
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(TasksListResponse.self, from: data).tasks
    }

    public func task(id: String) async throws -> TaskRecord {
        let request = try authorizedRequest(path: "/tasks/\(id)", method: "GET")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(TaskRecord.self, from: data)
    }

    public func createTask(_ input: NewTaskInput) async throws -> TaskRecord {
        var request = try authorizedRequest(path: "/tasks", method: "POST")
        var body: [String: Any] = ["title": input.title, "bucket": input.bucket.rawValue]
        if let priority = input.priority { body["priority"] = priority }
        if let dueDate = input.dueDate { body["dueDate"] = Self.isoString(dueDate) }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(TaskRecord.self, from: data)
    }

    // Only fields the caller actually set are sent -- `TaskPatch`'s
    // properties are all optional so a screen editing just the title, say,
    // never overwrites bucket/priority/status with stale local values.
    public func updateTask(id: String, patch: TaskPatch) async throws -> TaskRecord {
        var request = try authorizedRequest(path: "/tasks/\(id)", method: "PATCH")
        var body: [String: Any] = [:]
        if let title = patch.title { body["title"] = title }
        if let bucket = patch.bucket { body["bucket"] = bucket.rawValue }
        if let priority = patch.priority { body["priority"] = priority }
        if let dueDate = patch.dueDate { body["dueDate"] = dueDate.map(Self.isoString) ?? NSNull() }
        if let status = patch.status { body["status"] = status.rawValue }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(TaskRecord.self, from: data)
    }

    public func deleteTask(id: String) async throws {
        let request = try authorizedRequest(path: "/tasks/\(id)", method: "DELETE")
        _ = try await perform(request)
    }

    // MARK: - Clarifications

    public func clarifications(status: String? = "pending") async throws -> [Clarification] {
        let items = status.map { [URLQueryItem(name: "status", value: $0)] } ?? []
        let request = try authorizedRequest(path: "/tasks/clarifications", method: "GET", queryItems: items)
        let (data, _) = try await perform(request)
        return try Self.decodeJSON([Clarification].self, from: data)
    }

    // The daemon accepts exactly one of four fixed values here -- see
    // `ClarificationAnswer`'s doc comment -- never free text.
    public func answerClarification(id: String, answer: ClarificationAnswer) async throws -> ClarificationAnswerResponse {
        var request = try authorizedRequest(path: "/tasks/clarifications/\(id)/answer", method: "POST")
        request.httpBody = Data(#"{"answer":"\#(answer.rawValue)"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(ClarificationAnswerResponse.self, from: data)
    }

    // MARK: - Pending actions (mobile/PROTOCOL.md §6)

    public func pendingActions(status: String? = "pending") async throws -> [PendingAction] {
        let items = status.map { [URLQueryItem(name: "status", value: $0)] } ?? []
        let request = try authorizedRequest(path: "/pending-actions", method: "GET", queryItems: items)
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(PendingActionsResponse.self, from: data).actions
    }

    public func approvePendingAction(id: String) async throws -> ApprovalOutcome {
        let request = try authorizedRequest(path: "/pending-actions/\(id)/approve", method: "POST")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(ApprovalOutcome.self, from: data)
    }

    public func denyPendingAction(id: String, reason: String?) async throws -> DenyOutcome {
        var request = try authorizedRequest(path: "/pending-actions/\(id)/deny", method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: reason.map { ["reason": $0] } ?? [:])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(DenyOutcome.self, from: data)
    }

    // MARK: - Chat (mobile/FEATURES.md's Chat tab)

    // `POST /message` with `Accept: text/event-stream` streams its own
    // reply directly on this response -- a different mechanism from the
    // always-on `GET /events` broadcast below. See ChatEvent's doc comment.
    // Throws before returning a stream if the request itself can't even be
    // sent (bad host, non-2xx status); streaming failures thereafter surface
    // through the returned stream's `AsyncThrowingStream` itself.
    public func sendMessageStreaming(text: String) async throws -> AsyncThrowingStream<ChatEvent, Error> {
        var request = try authorizedRequest(path: "/message", method: "POST")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text])
        // A chat turn can run a tool loop; the daemon sends a heartbeat
        // frame every 15s specifically so this doesn't need to be short.
        request.timeoutInterval = 120
        let (bytes, response) = try await Self.bytesCall(request, session: session)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        if !(200...299).contains(http.statusCode) {
            // A non-2xx status here is a plain JSON error body, not an SSE
            // stream -- `validate(_:)` alone would report it as a bare
            // `.server(503)`, which is exactly what shipped as "Can't reach
            // OpenAGI" for the single most common test-daemon state (no
            // agent host configured). Read a short bounded prefix of the
            // same byte sequence to tell that case apart before falling
            // back to the generic status-code mapping.
            if http.statusCode == 503 {
                let body = (try? await Self.collectText(bytes, byteLimit: 4096)) ?? ""
                if body.contains("agent-host-disabled") { throw DaemonError.agentHostDisabled }
            }
            _ = try validate(response)
        }
        return AsyncThrowingStream { continuation in
            let pump = Task {
                var parser = SSEFrameParser()
                do {
                    for try await line in Self.lines(of: bytes) {
                        if Task.isCancelled { break }
                        if let frame = parser.feed(line), let chatEvent = ChatEvent.decode(frame) {
                            continuation.yield(chatEvent)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: DaemonError.transport(error))
                }
            }
            continuation.onTermination = { _ in pump.cancel() }
        }
    }

    // `GET /events` -- the long-lived broadcast connection (mobile/PROTOCOL.md
    // §7). Reconnect-with-backoff is the caller's job (see
    // `EventStreamController`): this returns one connection's worth of
    // events and finishes (or throws) when that connection ends.
    public func eventStream() async throws -> AsyncThrowingStream<DaemonEvent, Error> {
        var request = try authorizedRequest(path: "/events", method: "GET")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Long-lived by design; the daemon pings every 15s specifically so
        // intermediaries (and this timeout) don't treat silence as dead.
        request.timeoutInterval = 3600
        let (bytes, response) = try await Self.bytesCall(request, session: session)
        _ = try validate(response)
        return AsyncThrowingStream { continuation in
            let pump = Task {
                var parser = SSEFrameParser()
                do {
                    for try await line in Self.lines(of: bytes) {
                        if Task.isCancelled { break }
                        if let event = parser.feed(line) {
                            continuation.yield(DaemonEvent.from(name: event.name))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: DaemonError.transport(error))
                }
            }
            continuation.onTermination = { _ in pump.cancel() }
        }
    }

    // Enrollment happens before any credential exists, so it is static and
    // carries only the one-time code.
    public static func enroll(server: URL, code: String, nodeID: String, nodeToken: String,
                              name: String, session: URLSession = .shared) async throws -> Enrollment {
        let validated = try HostAllowlist.validate(server)
        var request = URLRequest(url: validated.appending(path: "/nodes/enroll/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code, "platform": "mobile", "nodeId": nodeID, "nodeToken": nodeToken, "name": name
        ])
        let (data, response) = try await networkCall(request, session: session)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200: return try decodeJSON(Enrollment.self, from: data)
        // 403 belongs here for the same reason it does on every other route: it
        // means the node id and credential disagree, not that the server broke.
        // This switch omitted it while `validate` included it, so an enrolling
        // phone reported a 403 as a server fault. Android maps all three.
        case 401, 403, 429: throw DaemonError.unauthorized
        case 409: throw DaemonError.conflict
        default: throw DaemonError.server(http.statusCode)
        }
    }

    // `URL.appending(path:)` percent-encodes its argument as a single path
    // component -- a literal "?status=pending" passed as `path` becomes the
    // literal characters "%3Fstatus=pending" in the URL's path, never a real
    // query string. `queryItems` goes through `URLComponents` instead, which
    // is the only way to get an actual `?a=b&c=d` on the request.
    private func authorizedRequest(path: String, method: String, queryItems: [URLQueryItem] = []) throws -> URLRequest {
        let base = try HostAllowlist.validate(server)
        var url = base.appending(path: path)
        if !queryItems.isEmpty {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                throw DaemonError.malformedResponse
            }
            components.queryItems = queryItems
            guard let composed = components.url else { throw DaemonError.malformedResponse }
            url = composed
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(nodeID, forHTTPHeaderField: "X-OpenAGI-Node-ID")
        request.timeoutInterval = 12
        return request
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await Self.networkCall(request, session: session)
        let http = try validate(response)
        return (data, http)
    }

    // A dropped connection, timeout, DNS failure, or TLS error throws a raw
    // URLError from URLSession — never let that escape untyped, since every
    // caller pattern-matches on DaemonError.
    private static func networkCall(_ request: URLRequest, session: URLSession) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as DaemonError {
            throw error
        } catch {
            throw DaemonError.transport(error)
        }
    }

    // `URLSession.AsyncBytes.lines` never yielded a single line against
    // either this SDK's stubbed *or* real streaming responses in this
    // project's testing (verified live: the raw byte sequence underneath it
    // delivers every byte correctly -- `for try await _ in bytes` counted
    // the full response -- but `.lines` produced nothing). Splitting the
    // byte sequence into lines by hand sidesteps whatever that gap is, and
    // is simple enough to trust: accumulate until `\n`, drop a trailing
    // `\r`, decode as UTF-8, repeat.
    private static func lines(of bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var buffer: [UInt8] = []
                do {
                    for try await byte in bytes {
                        if Task.isCancelled { break }
                        if byte == 0x0A {
                            if buffer.last == 0x0D { buffer.removeLast() }
                            continuation.yield(String(decoding: buffer, as: UTF8.self))
                            buffer.removeAll(keepingCapacity: true)
                        } else {
                            buffer.append(byte)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(String(decoding: buffer, as: UTF8.self)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // A bounded read of a byte sequence into a `String` -- used only to peek
    // at a non-2xx response's small JSON error body before deciding which
    // `DaemonError` it maps to. Never used on a 2xx stream, which can run
    // for minutes and must not be buffered into memory like this.
    private static func collectText(_ bytes: URLSession.AsyncBytes, byteLimit: Int) async throws -> String {
        var buffer: [UInt8] = []
        buffer.reserveCapacity(byteLimit)
        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count >= byteLimit { break }
        }
        return String(decoding: buffer, as: UTF8.self)
    }

    // A dropped connection, timeout, DNS failure, or TLS error throws a raw
    // URLError here too -- same contract as `networkCall` above, just for
    // the streaming bytes API instead of `data(for:)`.
    private static func bytesCall(_ request: URLRequest, session: URLSession) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do {
            return try await session.bytes(for: request)
        } catch let error as DaemonError {
            throw error
        } catch {
            throw DaemonError.transport(error)
        }
    }

    // The daemon's own dates round-trip through fractional-second ISO-8601
    // (see ProtocolDecoder); this is the encode-side counterpart for the
    // `[String: Any]` request bodies this file builds by hand, which
    // JSONEncoder's `.iso8601` strategy can't reach into.
    private static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func decodeJSON<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try ProtocolDecoder.json.decode(type, from: data)
        } catch let error as DaemonError {
            throw error
        } catch {
            throw DaemonError.malformedResponse
        }
    }

    @discardableResult
    private func validate(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200...299, 304: return http
        // 403 specifically means the bearer token doesn't match the
        // X-OpenAGI-Node-ID header's node (a scoping mismatch), not an
        // expired/invalid token — but a mobile client can't do anything
        // different for one versus the other, so both surface as
        // .unauthorized. Don't write UI copy on a 403 that claims "your
        // token expired"; it may not have.
        case 401, 403: throw DaemonError.unauthorized
        case 404: throw DaemonError.notFound
        case 409: throw DaemonError.conflict
        default: throw DaemonError.server(http.statusCode)
        }
    }
}
