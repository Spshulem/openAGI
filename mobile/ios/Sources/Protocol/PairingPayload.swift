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
}
