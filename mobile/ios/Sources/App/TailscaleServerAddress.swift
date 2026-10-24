import Foundation
import Darwin

// iOS cannot read another app's Tailscale peer list, and Bonjour doesn't
// cross a tailnet. Resolve only the server the person saved or entered.
enum TailscaleServerAddress {
    static func parse(_ text: String) -> URL? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              var parts = URLComponents(string: text.contains("://") ? text : "http://\(text)"),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              ["http", "https"].contains(parts.scheme?.lowercased() ?? "") else { return nil }
        if !text.contains("://") && parts.port == nil { parts.port = 43210 }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    static func needsDNS(_ url: URL) -> Bool {
        url.scheme == "http" && HostAllowlist.isBlockedByAppTransportSecurity(url.host ?? "")
    }

    static func resolve(_ url: URL,
                        lookup: @escaping @Sendable (String) async -> String? = { await reverseName($0) }) async -> URL? {
        if !needsDNS(url) { return try? HostAllowlist.validate(url) }
        guard let host = url.host, let rawName = await lookup(host) else { return nil }
        let name = rawName.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard name.hasSuffix(".ts.net"), !name.contains(".."),
              name.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.host = name
        guard let resolved = parts.url else { return nil }
        return try? HostAllowlist.validate(resolved)
    }

    private static func reverseName(_ ip: String) async -> String? {
        await withCheckedContinuation { continuation in
            let result = DNSResult(continuation)
            DispatchQueue.global(qos: .utility).async {
                var address = sockaddr_in()
                address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
                address.sin_family = sa_family_t(AF_INET)
                guard inet_pton(AF_INET, ip, &address.sin_addr) == 1 else { result.finish(nil); return }
                var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let status = withUnsafePointer(to: &address) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        getnameinfo($0, socklen_t(MemoryLayout<sockaddr_in>.size), &hostname,
                                    socklen_t(hostname.count), nil, 0, NI_NAMEREQD)
                    }
                }
                result.finish(status == 0 ? String(cString: hostname) : nil)
            }
            // System DNS may block; never hold the discovery UI open for it.
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 3) { result.finish(nil) }
        }
    }
}

private final class DNSResult: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String?, Never>?

    init(_ continuation: CheckedContinuation<String?, Never>) { self.continuation = continuation }

    func finish(_ value: String?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}
