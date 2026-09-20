import Foundation

public enum HostAllowlist {
    // Cleartext is fine over WireGuard and on a home LAN, and nowhere else.
    // This is the whole reason the app can ship without TLS setup, so it is
    // enforced in one place and tested directly.
    public static func validate(_ url: URL) throws -> URL {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
            throw DaemonError.unreachableHost(url.absoluteString)
        }
        // A phone can never reach the daemon's own loopback address, over any
        // scheme — refused unconditionally, per mobile/PROTOCOL.md §10. This must
        // run before the https branch below, or https://127.0.0.1 would sail
        // through on "https is always allowed" alone.
        if isLoopback(host) { throw DaemonError.unreachableHost(host) }
        if scheme == "https" { return url }
        guard scheme == "http" else { throw DaemonError.unreachableHost(url.absoluteString) }
        if host.hasSuffix(".ts.net") { return url }
        if isPrivateOrTailscale(host) { return url }
        throw DaemonError.unreachableHost(host)
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }

    private static func isPrivateOrTailscale(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        switch (parts[0], parts[1]) {
        case (10, _): return true
        case (192, 168): return true
        case (172, 16...31): return true
        case (100, 64...127): return true   // Tailscale CGNAT range
        default: return false
        }
    }
}
