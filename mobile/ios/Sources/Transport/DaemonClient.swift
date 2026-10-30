import Foundation

public enum MainConnectionIssue: String, Sendable, Equatable {
    case authorizationRequired = "main-pairing-required"
    case unavailable = "main-unavailable"
    case routingLoop = "main-routing-loop"

    public var message: String {
        switch self {
        case .authorizationRequired:
            "This worker reached main, but main hasn't authorized this phone. Use your existing main-issued phone pairing in Connection Settings. Your current pairing has been kept."
        case .unavailable:
            "This worker can't reach main. Check the worker's main connection, then refresh. Your saved work and pairing have been kept."
        case .routingLoop:
            "This worker's main address points to another worker in a loop. Correct its main connection, then refresh."
        }
    }
}

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
    case imagesUnsupported
    case mainConnection(MainConnectionIssue)
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
        case (.agentHostDisabled, .agentHostDisabled), (.imagesUnsupported, .imagesUnsupported): return true
        case let (.mainConnection(a), .mainConnection(b)): return a == b
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

// `POST /mobile/push`'s answer.
public struct PushRegistrationResult: Decodable, Sendable, Equatable {
    public var renew: Bool

    public init(renew: Bool = false) {
        self.renew = renew
    }

    private enum CodingKeys: String, CodingKey { case renew }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        renew = (try? c.decodeIfPresent(Bool.self, forKey: .renew)) ?? false
    }
}

public actor DaemonClient {
    private let server: URL
    private let nodeID: String
    private let token: String
    private let session: URLSession
    // Set when this pairing's main rejected `thread` on `/message` (it
    // predates shared threads). In memory only: a relaunch probes again, so
    // an updated main is picked up.
    private var sharedThreadsUnsupported = false

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

    // The morning plan and evening recap, for phone-only mode's local
    // notifications (a Mac sends its own).
    public func dailyPlan() async throws -> DailyPlanDigest {
        let request = try authorizedRequest(path: "/plan/daily", method: "GET", queryItems: [URLQueryItem(name: "llm", value: "0")])
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(DailyPlanDigest.self, from: data)
    }

    public func dailyRecap() async throws -> DailyRecapDigest {
        let (data, _) = try await perform(try authorizedRequest(path: "/recap/daily", method: "GET"))
        return try Self.decodeJSON(DailyRecapDigest.self, from: data)
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

    // Not routed through `perform()`: the daemon answers 400 (not just 200)
    // with a real `{ok:false, error:"..."}` body when the approved tool ran
    // and failed -- src/hosted-interface.js's approve handler returns
    // `invokeResult.ok ? 200 : 400`. Rejecting that status before decoding
    // made the Inbox's `!outcome.ok` branch unreachable and reported a failed
    // tool as "Can't reach OpenAGI". Android's `approveAction` does the same.
    public func approvePendingAction(id: String) async throws -> ApprovalOutcome {
        let request = try authorizedRequest(path: "/pending-actions/\(id)/approve", method: "POST")
        let (data, response) = try await Self.networkCall(request, session: session)
        if (response as? HTTPURLResponse)?.statusCode == 400 {
            return try Self.decodeJSON(ApprovalOutcome.self, from: data)
        }
        _ = try validate(response, data: data)
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
    //
    // `thread` puts the turn in one of the owner's two shared device threads
    // ("agent" or "supervisor"), the same conversation the G2 glasses and
    // any other paired phone read and write. A main from before shared
    // threads rejects the field with a 400, so the send is retried once
    // without it and keyed on `from` instead -- which is why the Supervisor
    // chat also sends `from`/`sessionId` as "mobile-supervisor": on an older
    // main that still keeps it apart from Chat, and on a newer one the
    // thread wins.
    public func sendMessageStreaming(text: String, thread: ConversationThread? = nil,
                                     from: String? = nil, sessionId: String? = nil, attachments: [ChatAttachment] = [], conversationId: String = "main") async throws -> AsyncThrowingStream<ChatEvent, Error> {
        // Check before uploading pixels. Older mains can reject a large body
        // before returning a useful error; that is not a dropped agent turn.
        if !attachments.isEmpty { try await requireImageSupport() }
        var body: [String: Any] = ["text": text]
        if !attachments.isEmpty {
            body["attachments"] = try JSONSerialization.jsonObject(with: ProtocolDecoder.jsonEncoder.encode(attachments))
        }
        if let from { body["from"] = from }
        if let sessionId { body["sessionId"] = sessionId }
        if conversationId != "main" { body["conversationId"] = conversationId }
        if conversationId != "main" && sharedThreadsUnsupported { throw DaemonError.notFound }
        let bytes: URLSession.AsyncBytes
        if let thread, !sharedThreadsUnsupported {
            var threaded = body
            threaded["thread"] = thread.rawValue
            do {
                bytes = try await openMessageStream(body: threaded)
            } catch is SharedThreadsRejected {
                // A named chat must never fall back into the default chat.
                guard conversationId == "main" else { throw DaemonError.notFound }
                // An older main's node-scoped `/message` allows only text,
                // from, and sessionId, and 400s anything else during
                // validation -- before the turn runs -- so resending
                // without `thread` cannot double-send. Remembered for this
                // client (one per pairing) until relaunch.
                sharedThreadsUnsupported = true
                bytes = try await openMessageStream(body: body)
            }
        } else {
            bytes = try await openMessageStream(body: body)
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

    private struct SharedThreadsRejected: Error {}

    private struct MessageCapabilities: Decodable { let imageAttachments: Bool }

    private func requireImageSupport() async throws {
        let request = try authorizedRequest(path: "/mobile/capabilities", method: "GET")
        do {
            let (data, http) = try await perform(request)
            try Self.requireConversationJSON(data: data, response: http)
            guard try Self.decodeJSON(MessageCapabilities.self, from: data).imageAttachments else {
                throw DaemonError.imagesUnsupported
            }
        } catch DaemonError.unauthorized {
            // A legacy route can be owner-only even though this enrollment
            // is valid. Prove that separately; never replace its credential.
            try await heartbeat()
            throw DaemonError.imagesUnsupported
        } catch DaemonError.notFound {
            throw DaemonError.imagesUnsupported
        } catch DaemonError.malformedResponse {
            throw DaemonError.imagesUnsupported
        }
    }

    private func performConversationRequest(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do { return try await perform(request) }
        catch DaemonError.unauthorized {
            // A valid heartbeat plus a rejected catalog means this feature
            // is unavailable, not that the saved enrollment has expired.
            try await heartbeat()
            throw DaemonError.notFound
        }
    }

    private func openMessageStream(body: [String: Any]) async throws -> URLSession.AsyncBytes {
        var request = try authorizedRequest(path: "/message", method: "POST")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        // A chat turn can run a tool loop; the daemon sends a heartbeat
        // frame every 15s specifically so this doesn't need to be short.
        request.timeoutInterval = 120
        let (bytes, response) = try await Self.bytesCall(request, session: session)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        if !(200...299).contains(http.statusCode) {
            if [502, 508].contains(http.statusCode) {
                let text = (try? await Self.collectText(bytes, byteLimit: 4096)) ?? ""
                _ = try validate(response, data: Data(text.utf8))
            }
            // A non-2xx status here is a plain JSON error body, not an SSE
            // stream -- `validate(_:)` alone would report it as a bare
            // `.server(503)`, which is exactly what shipped as "Can't reach
            // OpenAGI" for the single most common test-daemon state (no
            // agent host configured). Read a short bounded prefix of the
            // same byte sequence to tell that case apart before falling
            // back to the generic status-code mapping.
            if http.statusCode == 503 {
                let text = (try? await Self.collectText(bytes, byteLimit: 4096)) ?? ""
                if text.contains("agent-host-disabled") { throw DaemonError.agentHostDisabled }
            }
            // src/hosted-interface.js before shared threads: "node message
            // contains unsupported fields". Only meaningful when `thread`
            // was sent; the caller retries once without it.
            if http.statusCode == 413, body["attachments"] != nil { throw DaemonError.imagesUnsupported }
            if http.statusCode == 400 {
                let text = (try? await Self.collectText(bytes, byteLimit: 4096)) ?? ""
                if text.contains("unsupported fields") {
                    if body["attachments"] != nil { throw DaemonError.imagesUnsupported }
                    if body["thread"] != nil { throw SharedThreadsRejected() }
                }
            }
            _ = try validate(response)
        }
        return bytes
    }

    // `GET /conversations/:thread/messages` -- the shared thread's stored
    // user/assistant turns, oldest first. A main from before shared threads
    // answers 404 (`DaemonError.notFound`); callers keep their local cache
    // and say the main needs updating.
    public func conversationMessages(thread: ConversationThread, before: String? = nil, limit: Int = 50, conversationId: String = "main") async throws -> ConversationPage {
        var items = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))]
        if conversationId != "main" { items.append(URLQueryItem(name: "conversationId", value: conversationId)) }
        if let before { items.append(URLQueryItem(name: "before", value: before)) }
        let request = try authorizedRequest(path: "/conversations/\(thread.rawValue)/messages", method: "GET", queryItems: items)
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(ConversationPage.self, from: data)
    }

    public func conversations() async throws -> [ConversationSummary] {
        let request = try authorizedRequest(path: "/conversations", method: "GET")
        let (data, http) = try await performConversationRequest(request)
        try Self.requireConversationJSON(data: data, response: http)
        return try Self.decodeJSON(ConversationCatalog.self, from: data).conversations
    }

    public func createConversation(thread: ConversationThread, sourceId: String? = nil) async throws -> ConversationSummary {
        var body = ["thread": thread.rawValue]
        if let sourceId { body["sourceId"] = sourceId }
        var request = try authorizedRequest(path: "/conversations", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, http) = try await performConversationRequest(request)
        try Self.requireConversationJSON(data: data, response: http)
        return try Self.decodeJSON(ConversationSummary.self, from: data)
    }

    private static func requireConversationJSON(data: Data, response: HTTPURLResponse) throws {
        // Older dashboards return their HTML app shell with 200 for unknown
        // GET routes. That is an unsupported catalog, not a lost pairing.
        let type = response.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        let prefix = String(decoding: data.prefix(128), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if type.contains("text/html") || prefix.hasPrefix("<!doctype html") || prefix.hasPrefix("<html") {
            throw DaemonError.notFound
        }
    }

    // MARK: - Lifelog

    // `GET /lifelog/moments` -- what the owner's G2 glasses heard, newest
    // first. `date` is a local calendar day ("2026-09-28"); `query` filters
    // by words, person, or topic. 404 on a main from before this route.
    public func lifelogMoments(date: String?, query: String?, limit: Int = 100) async throws -> [LifelogMoment] {
        var items: [URLQueryItem] = []
        if let date, !date.isEmpty { items.append(URLQueryItem(name: "date", value: date)) }
        if let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            items.append(URLQueryItem(name: "query", value: query))
        }
        items.append(URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100))))
        let request = try authorizedRequest(path: "/lifelog/moments", method: "GET", queryItems: items)
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(LifelogMomentsResponse.self, from: data).moments
    }

    // MARK: - Fleet supervisor (mobile/FEATURES.md's Supervisor tab)

    // 503 always means "no supervisor on this daemon", as does a 404 on
    // state/scan/mode; the Supervisor screen maps both. On a question or an
    // action a 404 means that one item is gone and 409 that it was already
    // closed elsewhere -- `.notFound` / `.conflict`, as everywhere else.
    public func fleetThreadDetail(key: String) async throws -> FleetThreadDetail {
        // One identity segment, never an arbitrary caller-supplied path.
        guard key.range(of: #"^(codex|claude|conductor|antigravity):[A-Za-z0-9_.-]{1,120}$"#, options: .regularExpression) != nil else {
            throw DaemonError.malformedResponse
        }
        let request = try authorizedRequest(path: "/fleet/api/threads/\(key)", method: "GET")
        let (data, _) = try await perform(request)
        let detail = try Self.decodeJSON(FleetThreadDetailResponse.self, from: data).thread
        guard detail.key == key else { throw DaemonError.malformedResponse }
        return detail
    }

    public func fleetState() async throws -> FleetState {
        let request = try authorizedRequest(path: "/fleet/api/state", method: "GET")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(FleetState.self, from: data)
    }

    // A scan can take up to ~100s. No body: the route reads none.
    public func fleetScan() async throws -> FleetState {
        var request = try authorizedRequest(path: "/fleet/api/scan", method: "POST")
        request.timeoutInterval = 120
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(FleetState.self, from: data)
    }

    public func fleetSetMode(_ mode: FleetMode) async throws -> FleetState {
        var request = try authorizedRequest(path: "/fleet/api/mode", method: "POST")
        request.httpBody = Data(#"{"mode":"\#(mode.rawValue)"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(FleetState.self, from: data)
    }

    // The answer must be one of the question's own options. Relaying it to
    // the agent can take up to ~190s.
    public func fleetAnswer(questionID: String, answer: String) async throws -> FleetMutationResult {
        var request = try authorizedRequest(path: "/fleet/api/questions/\(questionID)", method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["answer": answer])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 200
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(FleetMutationResult.self, from: data)
    }

    public func fleetDismiss(questionID: String) async throws -> FleetMutationResult {
        var request = try authorizedRequest(path: "/fleet/api/questions/\(questionID)", method: "POST")
        request.httpBody = Data(#"{"dismiss":true}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(FleetMutationResult.self, from: data)
    }

    // Propose mode only; the daemon answers 409 for anything not "proposed".
    public func fleetSendAction(id: String) async throws -> FleetMutationResult {
        var request = try authorizedRequest(path: "/fleet/api/actions/\(id)/send", method: "POST")
        request.timeoutInterval = 200
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(FleetMutationResult.self, from: data)
    }

    // MARK: - Supervisor push (docs/superpowers/specs/2026-10-15-ios-supervisor-push-design.md)

    // Hands this phone's relay pass and push key to its own daemon, over the
    // tailnet. The daemon replaces this node's earlier record (re-posting the
    // same pass keeps its activity state). `activities: false` means this
    // phone has no push-to-start token; `alerts: false` that notifications
    // are not allowed. `renew` in the answer means the relay refused this
    // pass (expired, revoked, unknown) and the phone should mint a new one.
    // Keys sorted so a test can assert the body byte for byte.
    public func registerPush(pass: String, key: String, env: String, activities: Bool,
                             alerts: Bool) async throws -> PushRegistrationResult {
        var request = try authorizedRequest(path: "/mobile/push", method: "POST")
        let body: [String: Any] = ["pass": pass, "key": key, "env": env, "activities": activities, "alerts": alerts]
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await perform(request)
        // An older daemon answers `{ ok: true }` only: no renew.
        return (try? JSONDecoder().decode(PushRegistrationResult.self, from: data)) ?? PushRegistrationResult()
    }

    public func unregisterPush() async throws {
        let request = try authorizedRequest(path: "/mobile/push", method: "DELETE")
        _ = try await perform(request)
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
                            continuation.yield(DaemonEvent.from(name: event.name, data: event.data))
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
        let http = try validate(response, data: data)
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
    private func validate(_ response: URLResponse, data: Data? = nil) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        if [502, 508].contains(http.statusCode), let data,
           let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let code = body["error"] as? String, let issue = MainConnectionIssue(rawValue: code) {
            throw DaemonError.mainConnection(issue)
        }
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

// The phone's workspace screens. Same credential as everything else; the
// daemon allows a phone node exactly these routes (src/mobile-node.js).
extension DaemonClient {
    private struct IntegrationList: Decodable { let integrations: [TaskIntegration] }

    public func taskIntegrations() async throws -> [TaskIntegration] {
        try await json(IntegrationList.self, path: "/workspace/integrations", method: "GET").integrations
    }

    public func updateTaskIntegration(id: String, apiKey: String?) async throws -> [TaskIntegration] {
        guard ["linear", "buildbetter"].contains(id) else { throw DaemonError.notFound }
        let body = try apiKey.map { try JSONSerialization.data(withJSONObject: ["apiKey": $0]) }
        return try await json(IntegrationList.self, path: "/workspace/integrations/\(id)",
                              method: apiKey == nil ? "DELETE" : "PUT", body: body).integrations
    }

    public func syncTaskIntegration(id: String) async throws -> TaskIntegrationSync {
        guard ["linear", "buildbetter"].contains(id) else { throw DaemonError.notFound }
        return try await json(TaskIntegrationSync.self, path: "/workspace/integrations/\(id)/sync", method: "POST",
                              body: Data("{}".utf8), timeout: 600)
    }

    private struct Wrapped<T: Decodable>: Decodable { let skills: T?; let jobs: T? }

    public func modelSettings() async throws -> ModelSettings {
        try await json(ModelSettings.self, path: "/settings/models", method: "GET")
    }

    public func updateModelSettings(_ update: ModelSettingsUpdate) async throws -> ModelSettings {
        try await json(ModelSettings.self, path: "/settings/models", method: "POST", body: try ProtocolDecoder.jsonEncoder.encode(update), timeout: 20)
    }

    public func testModel() async throws -> ModelTestResult {
        try await json(ModelTestResult.self, path: "/settings/models/test", method: "POST", body: Data("{}".utf8), timeout: 45)
    }

    public func persona() async throws -> PersonaDocument {
        try await json(PersonaDocument.self, path: "/workspace/persona", method: "GET")
    }

    public func savePersona(markdown: String) async throws -> PersonaDocument {
        let body = try JSONSerialization.data(withJSONObject: ["markdown": markdown])
        return try await json(PersonaDocument.self, path: "/workspace/persona", method: "PUT", body: body)
    }

    public func skills() async throws -> [SkillSummary] {
        try await json(Wrapped<[SkillSummary]>.self, path: "/workspace/skills", method: "GET").skills ?? []
    }

    public func skill(named name: String) async throws -> SkillDetail {
        try await json(SkillDetail.self, path: "/workspace/skills/\(name)", method: "GET")
    }

    public func saveSkill(name: String, description: String, instructions: String) async throws -> SkillDetail {
        let body = try JSONSerialization.data(withJSONObject: ["description": description, "instructions": instructions])
        return try await json(SkillDetail.self, path: "/workspace/skills/\(name)", method: "PUT", body: body)
    }

    public func deleteSkill(name: String) async throws {
        _ = try await perform(try authorizedRequest(path: "/workspace/skills/\(name)", method: "DELETE"))
    }

    public func scheduledJobs() async throws -> [ScheduledJob] {
        try await json(Wrapped<[ScheduledJob]>.self, path: "/workspace/jobs", method: "GET").jobs ?? []
    }

    public func setJob(id: String, enabled: Bool) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["enabled": enabled])
        var request = try authorizedRequest(path: "/workspace/jobs/\(id)", method: "POST")
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    // The offline copy: a snapshot of this daemon's agent, passed to the
    // phone's own daemon untouched, and what the phone did offline.
    public func mirrorSnapshot() async throws -> Data {
        var request = try authorizedRequest(path: "/mobile/mirror", method: "GET")
        request.timeoutInterval = 60
        return try await perform(request).0
    }

    public func sendOfflineWork(_ work: Data) async throws {
        var request = try authorizedRequest(path: "/mobile/offline-import", method: "POST")
        request.httpBody = work
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    // Sign in with ChatGPT: the daemon owns the OAuth exchange.
    public func startChatGPTSignIn() async throws -> URL {
        struct Started: Decodable { let authorizeUrl: String }
        let body = try JSONSerialization.data(withJSONObject: ["returnTo": "openagi"])
        let started = try await json(Started.self, path: "/auth/chatgpt/start", method: "POST", body: body)
        guard let url = URL(string: started.authorizeUrl), url.scheme == "https" else { throw DaemonError.malformedResponse }
        return url
    }

    public func signOutChatGPT() async throws {
        var request = try authorizedRequest(path: "/auth/chatgpt/signout", method: "POST")
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await perform(request)
    }

    private func json<T: Decodable>(_ type: T.Type, path: String, method: String, body: Data? = nil, timeout: TimeInterval? = nil) async throws -> T {
        var request = try authorizedRequest(path: path, method: method)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let timeout { request.timeoutInterval = timeout }
        let (data, _) = try await perform(request)
        return try Self.decodeJSON(type, from: data)
    }
}
