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
        // iOS's own ATS exception for cleartext (`NSAllowsLocalNetworking` in
        // project.yml's Info.plist) only covers RFC 1918 private ranges and
        // `.local`/unqualified hostnames — it does NOT cover Tailscale's
        // 100.64.0.0/10 CGNAT range, which is RFC 6598 shared address space,
        // a different allocation. `NSExceptionDomains` can only name a
        // domain, never a /10 of raw IPs, so there is no ATS exception this
        // app can declare for a bare 100.x address. A request to one never
        // reaches this method's caller at all in practice: URLSession fails
        // it at the OS level with NSURLErrorAppTransportSecurityRequiresSecureConnection
        // (-1022) before a socket is even opened. mobile/PROTOCOL.md §10 and
        // this table both describe the daemon-side allowlist, which does
        // permit this range — refusing it here, client-side, with a legible
        // reason trades a mysterious platform-level timeout for an honest
        // "use the tailnet name instead". Android has no equivalent
        // restriction and keeps allowing this range (its cleartext policy is
        // not domain-scoped the way ATS is) — this is the one place the two
        // clients' tables intentionally diverge, and only on iOS.
        if isCGNAT(host) { throw DaemonError.unreachableHost(host) }
        if isPrivateOrTailscale(host) { return url }
        throw DaemonError.unreachableHost(host)
    }

    // Exposed so UI copy can distinguish this specific refusal (which has a
    // concrete fix: pair over the `*.ts.net` name) from a generic refused
    // host, without re-deriving the CIDR check or leaking prose into the
    // thrown error's payload.
    public static func isBlockedByAppTransportSecurity(_ host: String) -> Bool {
        isCGNAT(host.lowercased())
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }

    private static func isCGNAT(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 100 && (64...127).contains(parts[1])
    }

    private static func isPrivateOrTailscale(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        switch (parts[0], parts[1]) {
        case (10, _): return true
        case (192, 168): return true
        case (172, 16...31): return true
        default: return false   // 100.64-127 (CGNAT) is refused above, not allowed here.
        }
    }
}
