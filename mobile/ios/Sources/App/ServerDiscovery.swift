import Foundation
import Observation
import SwiftUI

struct DiscoveredServer: Identifiable {
    var id: String { address.absoluteString }
    let address: URL
    let name: String
}

// Bonjour is local-network discovery; saved/entered Tailscale origins are
// checked explicitly because WireGuard does not carry multicast discovery.
// No credentials are sent while browsing or checking liveness.
@Observable
@MainActor
final class ServerDiscovery: NSObject, @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate {
    private(set) var servers: [DiscoveredServer] = []
    private(set) var searching = false
    private(set) var note: String?
    private var browser: NetServiceBrowser?
    private var services: [NetService] = []
    private var search: Task<Void, Never>?
    private var generation = 0

    func start(addresses: [URL]) {
        stop()
        let run = generation
        servers = []
        searching = true
        note = "Looking on this Wi-Fi network and checking your saved or entered address…"
        let browser = NetServiceBrowser()
        browser.delegate = self
        self.browser = browser
        browser.searchForServices(ofType: "_openagi._tcp.", inDomain: "local.")
        search = Task {
            await withTaskGroup(of: URL?.self) { group in
                for address in Set(addresses) {
                    group.addTask { await Self.reachable(address) ? address : nil }
                }
                for await result in group {
                    guard !Task.isCancelled, generation == run else { return }
                    if let address = result { add(address, name: "Reachable saved or entered server") }
                }
            }
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, generation == run else { return }
            browser.stop()
            services.forEach { $0.stop() }
            searching = false
            note = servers.isEmpty
                ? "No servers found. Turn on Tailscale and Use Tailscale DNS, or join the same Wi-Fi as your server. You can also enter its address below."
                : "Check that the address matches your main server before entering its pairing code."
        }
    }

    func stop() {
        generation += 1
        search?.cancel()
        search = nil
        browser?.stop()
        browser?.delegate = nil
        browser = nil
        services.forEach { $0.stop(); $0.delegate = nil }
        services = []
        searching = false
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard searching, self.browser === browser, services.count < 12 else { return }
        services.append(service)
        service.delegate = self
        service.resolve(withTimeout: 4)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        guard self.browser === browser else { return }
        note = "Allow Local Network access in iOS Settings to find nearby servers. You can still enter and check a server address."
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard searching, services.contains(where: { $0 === sender }) else { return }
        let attributes = sender.txtRecordData().map(NetService.dictionary(fromTXTRecord:)) ?? [:]
        let advertised = (attributes["main"] ?? attributes["url"]).flatMap { String(data: $0, encoding: .utf8) }
        if let advertised, let address = URL(string: advertised) {
            add(address, name: String(sender.name.prefix(80)))
        } else if let hostname = sender.hostName, sender.port > 0 {
            var components = URLComponents()
            components.scheme = "http"
            components.host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            components.port = sender.port
            if let address = components.url { add(address, name: String(sender.name.prefix(80))) }
        }
    }

    private func add(_ url: URL, name: String) {
        guard let address = try? HostAllowlist.validate(url),
              !servers.contains(where: { $0.address == address }), servers.count < 12 else { return }
        servers.append(DiscoveredServer(address: address, name: name))
    }

    nonisolated static func reachable(_ url: URL) async -> Bool {
        guard let origin = try? HostAllowlist.validate(url) else { return false }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 5
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration, delegate: DiscoveryRedirectBlocker(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            var request = URLRequest(url: origin.appendingPathComponent("health"))
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (bytes, response) = try await session.bytes(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            var data = Data()
            for try await byte in bytes {
                guard data.count < 16_384 else { return false }
                data.append(byte)
            }
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true
        } catch { return false }
    }
}

private final class DiscoveryRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct ServerDiscoverySheet: View {
    let server: URL
    @Environment(\.dismiss) private var dismiss
    @State private var discovery = ServerDiscovery()

    var body: some View {
        NavigationStack {
            Form {
                Section("Saved server") {
                    Text(server.absoluteString).textSelection(.enabled)
                    Text("Your pairing stays saved. Searching does not switch servers or share any credentials.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button(discovery.searching ? "Searching…" : "Check connection and find servers", systemImage: "network") {
                        discovery.start(addresses: [server])
                    }.disabled(discovery.searching)
                    if let note = discovery.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(discovery.servers) { candidate in
                        LabeledContent(candidate.name) { Text(candidate.address.absoluteString).textSelection(.enabled) }
                    }
                } footer: {
                    Text("Finds Bonjour servers on this Wi-Fi network and checks your saved Tailscale address. Keep Tailscale and Use Tailscale DNS enabled. Nearby announcements identify candidates; a pairing code is still required to connect a new server.")
                }
            }
            .navigationTitle("Find servers")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onDisappear { discovery.stop() }
        }
    }
}
