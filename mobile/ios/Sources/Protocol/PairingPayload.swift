import Foundation

public struct PairingPayload: Sendable, Equatable {
    public let serverURL: URL
    public let code: String

    public init?(url: URL) {
        guard url.scheme == "openagi", url.host == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let rawServer = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let server = URL(string: rawServer),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              code.count == 6, code.allSatisfy(\.isNumber)
        else { return nil }
        self.serverURL = server
        self.code = code
    }

    public init(serverURL: URL, code: String) {
        self.serverURL = serverURL
        self.code = code
    }

    // True when two addresses name the same daemon: same scheme, host, and
    // port (a missing port means the scheme's default), ignoring case, path,
    // and a trailing slash. An old or replayed link for the daemon this phone
    // is already paired with must not offer "Switch" -- that revokes the
    // working credential before finding out the link's code is spent.
    public static func namesSameDaemon(_ current: URL, _ incoming: URL) -> Bool {
        guard let a = origin(current), let b = origin(incoming) else { return false }
        return a == b
    }

    private static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
        return "\(scheme)://\(host):\(port)"
    }
}
