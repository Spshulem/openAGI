package sh.openagi.mobile.transport

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// Cleartext is fine over WireGuard and on a home LAN, and nowhere else.
// This is the whole reason the app can ship without TLS setup, so it is
// enforced in one place and tested directly. Keep this table byte-for-byte
// in agreement with mobile/ios/Sources/Transport/HostAllowlist.swift.
object HostAllowlist {
    fun validate(raw: String): HttpUrl {
        val url = raw.toHttpUrlOrNull() ?: throw DaemonException.UnreachableHost(raw)
        // Drop any path so callers can append their own without doubling it.
        val origin = HttpUrl.Builder()
            .scheme(url.scheme)
            .host(url.host)
            .port(url.port)
            .build()
        // Loopback is refused whatever the scheme, per PROTOCOL.md §10: a phone
        // cannot reach its own loopback, so accepting one turns a pairing typo
        // into a silent hang instead of an immediate, legible refusal. This check
        // precedes the scheme branch deliberately — putting it after would let
        // https://127.0.0.1 through, which is the gap iOS shipped and had to fix.
        if (url.host.lowercase() in setOf("127.0.0.1", "localhost", "::1")) {
            throw DaemonException.UnreachableHost(url.host)
        }
        if (url.scheme == "https") return origin
        if (url.scheme != "http") throw DaemonException.UnreachableHost(raw)
        val host = url.host.lowercase()
        if (host.endsWith(".ts.net")) return origin
        if (isPrivateOrTailscale(host)) return origin
        throw DaemonException.UnreachableHost(host)
    }

    private fun isPrivateOrTailscale(host: String): Boolean {
        val parts = host.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return false
        val (a, b) = parts
        return when {
            a == 10 -> true
            a == 192 && b == 168 -> true
            a == 172 && b in 16..31 -> true
            a == 100 && b in 64..127 -> true // Tailscale CGNAT range
            else -> false
        }
    }
}
