import Foundation

enum PairingConnectionFailure {
    static func detail(for error: Error, server: URL) -> String {
        // Report the attempted origin, never a URL containing query values
        // or user info, so a scheme/port mismatch can be corrected directly.
        var parts = URLComponents(url: server, resolvingAgainstBaseURL: false)
        parts?.user = nil; parts?.password = nil
        parts?.path = ""; parts?.query = nil; parts?.fragment = nil
        let address = parts?.url?.absoluteString ?? "the entered server"
        let host = server.host?.lowercased() ?? ""
        let tailnet = host.hasSuffix(".ts.net") || HostAllowlist.isBlockedByAppTransportSecurity(host)
        let recovery = tailnet
            ? "Open Tailscale on this phone, turn its connection on, and enable Tailscale DNS."
            : "Check the Wi-Fi connection and allow OpenAGI in Settings → Privacy & Security → Local Network."
        guard let network = error as? URLError else { return "Could not reach \(address). \(recovery)" }
        switch network.code {
        case .cannotFindHost, .dnsLookupFailed:
            return "This phone could not resolve \(address). \(recovery)"
        case .appTransportSecurityRequiresSecureConnection:
            return "iOS blocked the connection to \(address). Copy the full HTTPS address and port shown with your pairing code."
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .secureConnectionFailed:
            return "This phone could not verify the secure connection to \(address). Check the phone’s date and the server certificate."
        case .cannotConnectToHost:
            return "This phone could not connect to \(address). Use the complete address shown with the code, including its HTTP or HTTPS scheme and port. \(recovery)"
        default:
            return "This phone could not reach \(address). \(recovery)"
        }
    }
}
