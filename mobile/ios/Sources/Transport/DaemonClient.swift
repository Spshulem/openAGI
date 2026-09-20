import Foundation

public enum DaemonError: Error {
    case unreachableHost(String)
    case unauthorized
    case notFound
    case conflict
    case server(Int)
    case malformedResponse
    case transport(Error)
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
        case 401, 429: throw DaemonError.unauthorized
        case 409: throw DaemonError.conflict
        default: throw DaemonError.server(http.statusCode)
        }
    }

    private func authorizedRequest(path: String, method: String) throws -> URLRequest {
        let base = try HostAllowlist.validate(server)
        var request = URLRequest(url: base.appending(path: path))
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
