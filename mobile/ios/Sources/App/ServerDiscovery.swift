import Foundation
import Observation
import SwiftUI

struct DiscoveredServer: Identifiable {
    var id: String { address.absoluteString }
    let address: URL
    let name: String
    var reachable: Bool? = nil
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
    private(set) var search: Task<Void, Never>?
    private var generation = 0
    private var browserFailure: String?
    private let makeBrowser: () -> NetServiceBrowser
    private let check: @Sendable (URL) async -> Bool
    private let searchWindow: Duration

    init(makeBrowser: @escaping () -> NetServiceBrowser = { NetServiceBrowser() },
         check: @escaping @Sendable (URL) async -> Bool = { await ServerDiscovery.reachable($0) },
         searchWindow: Duration = .seconds(8)) {
        self.makeBrowser = makeBrowser
        self.check = check
        self.searchWindow = searchWindow
        super.init()
    }

    func start(addresses: [URL]) {
        stop()
        let run = generation
        servers = []
        browserFailure = nil
        searching = true
        note = "Looking on this Wi-Fi network and checking your saved or entered address…"
        let browser = makeBrowser()
        browser.delegate = self
        self.browser = browser
        browser.searchForServices(ofType: "_openagi._tcp.", inDomain: "local.")
        search = Task {
            let check = self.check
            await withTaskGroup(of: (URL, Bool).self) { group in
                for address in Set(addresses) {
                    guard let address = try? HostAllowlist.validate(address) else { continue }
                    add(address, name: "Saved or entered server")
                    group.addTask { (address, await check(address)) }
                }
                for await (address, reachable) in group {
                    guard !Task.isCancelled, generation == run else { return }
                    add(address, name: "Saved or entered server", reachable: reachable)
                }
            }
            if browserFailure == nil { try? await Task.sleep(for: searchWindow) }
            guard !Task.isCancelled, generation == run else { return }
            browser.stop()
            services.forEach { $0.stop() }
            searching = false
            note = browserFailure ?? (servers.isEmpty
                ? "No servers found. Turn on Tailscale and Use Tailscale DNS, or join the same Wi-Fi as your server. You can also enter its address below."
                : "Check that the address matches your main server before entering its pairing code.")
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
        browserFailure = "Nearby discovery couldn't start. Allow Local Network access for OpenAGI in iOS Settings, then retry. Saved or entered addresses are checked separately; Tailscale must be connected on both devices."
        note = browserFailure
        browser.stop()
        searching = false
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

    private func add(_ url: URL, name: String, reachable: Bool? = nil) {
        guard let address = try? HostAllowlist.validate(url) else { return }
        if let index = servers.firstIndex(where: { $0.address == address }) {
            if let reachable { servers[index].reachable = reachable }
        } else if servers.count < 12 {
            servers.append(DiscoveredServer(address: address, name: name, reachable: reachable))
        }
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
                        VStack(alignment: .leading) {
                            Text(candidate.name)
                            Text(candidate.address.absoluteString).textSelection(.enabled)
                            Text(candidate.reachable.map { $0 ? "OpenAGI is responding" : "Not reachable · check server and network" } ?? "Nearby announcement or connection check pending")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
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
