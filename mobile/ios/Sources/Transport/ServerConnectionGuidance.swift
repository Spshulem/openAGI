import Foundation

enum ServerConnectionGuidance {
    static let tailscaleRequirement = "Tailscale is required for this address. Keep it connected on this iPhone and the server, with Tailscale DNS enabled."

    static func requiresTailscale(_ server: URL) -> Bool {
        let host = normalizedHost(server)
        return host.hasSuffix(".ts.net") || HostAllowlist.isBlockedByAppTransportSecurity(host)
    }

    static func recovery(for server: URL) -> String {
        if requiresTailscale(server) {
            return "Open Tailscale on this phone, turn its connection on, and enable Tailscale DNS. Tailscale must also be connected on the server."
        }
        let host = normalizedHost(server)
        let octets = host.split(separator: ".").compactMap { Int($0) }
        let privateIP = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
            && (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && (16...31).contains(octets[1])))
        if privateIP || host.hasSuffix(".local") || !host.contains(".") {
            return "Check the Wi-Fi connection and allow OpenAGI in Settings → Privacy & Security → Local Network."
        }
        return "Check this phone’s internet connection and that the server’s HTTPS address is online. Tailscale is not required for a public HTTPS server."
    }

    private static func normalizedHost(_ server: URL) -> String {
        (server.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    }
}
