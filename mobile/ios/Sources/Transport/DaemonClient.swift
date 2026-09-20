import Foundation

public enum DaemonError: Error, Equatable {
    case unreachableHost(String)
    case unauthorized
    case notFound
    case conflict
    case server(Int)
    case malformedResponse
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
        let (data, response) = try await session.data(for: request)
        let http = try validate(response)
        if http.statusCode == 304 { return .unchanged }
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: data)
        return .fresh(summary, etag: http.value(forHTTPHeaderField: "ETag"))
    }

    public func complete(taskID: String) async throws {
        var request = try authorizedRequest(path: "/tasks/\(taskID)/complete", method: "POST")
        request.httpBody = Data(#"{"completedVia":"mobile"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try validate(try await session.data(for: request).1)
    }

    public func heartbeat() async throws {
        var request = try authorizedRequest(path: "/nodes/heartbeat", method: "POST")
        // role is required and must be exactly "node". The name is deliberately
        // omitted: the daemon stores the name this node enrolled with and ignores
        // anything the wire claims, so sending one could only ever disagree.
        request.httpBody = try ProtocolDecoder.jsonEncoder.encode(["nodeId": nodeID, "role": "node"])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try validate(try await session.data(for: request).1)
    }

    public func revoke() async throws {
        var request = try authorizedRequest(path: "/nodes/revoke", method: "POST")
        request.httpBody = try ProtocolDecoder.jsonEncoder.encode(["nodeId": nodeID])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try validate(try await session.data(for: request).1)
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
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200: return try ProtocolDecoder.json.decode(Enrollment.self, from: data)
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

    @discardableResult
    private func validate(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200...299, 304: return http
        case 401, 403: throw DaemonError.unauthorized
        case 404: throw DaemonError.notFound
        case 409: throw DaemonError.conflict
        default: throw DaemonError.server(http.statusCode)
        }
    }
}
