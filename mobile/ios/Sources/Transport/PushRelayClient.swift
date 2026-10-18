import Foundation

public enum PushRelayError: Error, Equatable {
    case rejected(String?)
    case server(Int)
    case malformedResponse
    case transport
}

// The push relay (relay/, a Cloudflare Worker). The phone calls
// `POST /v1/register` to trade its APNs tokens for an opaque `pass` the relay
// sealed for itself (the pass, never the tokens, then goes to the daemon),
// and `POST /v1/unregister` to retire a pass it replaced. The relay sees no
// node token, no push key and no content.
public struct PushRelayClient: Sendable {
    public static let defaultURL = URL(string: "https://push.openagi.sh")!
    // Info.plist key (set from the OPENAGI_PUSH_RELAY build setting) for a
    // self-hosted relay. Empty or unusable means the default.
    public static let infoKey = "OpenAGIPushRelay"

    public let base: URL
    private let session: URLSession

    public init(base: URL = PushRelayClient.configuredURL(), session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    // https only, except loopback (a simulator talking to `wrangler dev`).
    public static func configuredURL(info: [String: Any]? = Bundle.main.infoDictionary) -> URL {
        guard let raw = (info?[infoKey] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased()
        else { return defaultURL }
        if scheme == "https" { return url }
        if scheme == "http", host == "localhost" || host == "127.0.0.1" { return url }
        return defaultURL
    }

    // No start token (Live Activities off or unsupported): the relay makes
    // no broadcast channel and the pass carries alerts only.
    public func register(deviceToken: String, startToken: String?, env: String) async throws -> String {
        var body = ["deviceToken": deviceToken, "env": env]
        if let startToken { body["startToken"] = startToken }
        let object = try await post("/v1/register", body: body)
        guard let pass = object?["pass"] as? String, pass.hasPrefix("p1."), pass.count <= 2000 else {
            throw PushRelayError.malformedResponse
        }
        return pass
    }

    // Deletes the pass's broadcast channel, if it has one. The relay answers
    // ok even when the channel is already gone.
    public func unregister(pass: String) async throws {
        do {
            _ = try await post("/v1/unregister", body: ["pass": pass])
        } catch PushRelayError.rejected(let code) where code == "pass_expired" || code == "pass_revoked" {
            // These passes can no longer send and need no further retirement.
        }
    }

    private func post(_ path: String, body: [String: String]) async throws -> [String: Any]? {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PushRelayError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw PushRelayError.malformedResponse }
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (200...299).contains(http.statusCode) else {
            if let code = object?["error"] as? String { throw PushRelayError.rejected(code) }
            throw PushRelayError.server(http.statusCode)
        }
        return object
    }
}

// APNs tokens go to the relay as lowercase hex.
extension Data {
    public var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
