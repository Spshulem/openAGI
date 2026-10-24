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
    private let resolveAddress: @Sendable (URL) async -> URL?
    private let searchWindow: Duration

    init(makeBrowser: @escaping () -> NetServiceBrowser = { NetServiceBrowser() },
         check: @escaping @Sendable (URL) async -> Bool = { await ServerDiscovery.reachable($0) },
         resolveAddress: @escaping @Sendable (URL) async -> URL? = { await TailscaleServerAddress.resolve($0) },
         searchWindow: Duration = .seconds(8)) {
        self.makeBrowser = makeBrowser
        self.check = check
        self.searchWindow = searchWindow
        self.resolveAddress = resolveAddress
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
            let resolveAddress = self.resolveAddress
            await withTaskGroup(of: (URL, URL?, Bool).self) { group in
                for address in Set(addresses) {
                    // Keep a saved 100.x address visible even though ATS
                    // requires its MagicDNS name. Resolve only that host,
                    // off the UI thread, without sending any credentials.
                    guard (try? HostAllowlist.validate(address)) != nil || TailscaleServerAddress.needsDNS(address) else { continue }
                    addCandidate(address, name: "Saved or entered server")
                    group.addTask {
                        guard let resolved = await resolveAddress(address) else { return (address, nil, false) }
                        return (address, resolved, await check(resolved))
                    }
                }
                for await (original, resolved, reachable) in group {
                    guard !Task.isCancelled, generation == run else { return }
                    if let resolved, resolved != original {
                        servers.removeAll { $0.address == original }
                    }
                    addCandidate(resolved ?? original, name: "Saved or entered server", reachable: reachable)
                }
            }
            if browserFailure == nil { try? await Task.sleep(for: searchWindow) }
            guard !Task.isCancelled, generation == run else { return }
            browser.stop()
            services.forEach { $0.stop() }
            searching = false
            note = browserFailure ?? (servers.isEmpty
                ? "No Wi-Fi announcements found. Tailscale does not broadcast servers. In Tailscale, open the device list, select your Mac or Distiller, and copy its DNS name into Server address, then check again."
                : "Search complete. Check the server status below. Finding a server does not change your saved pairing.")
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
        addCandidate(address, name: name, reachable: reachable)
    }

    private func addCandidate(_ address: URL, name: String, reachable: Bool? = nil) {
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
    @State private var addressText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Saved server") {
                    Text(server.absoluteString).textSelection(.enabled)
                    Text("Your pairing stays saved. Searching does not switch servers or share any credentials.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Tailscale or Wi-Fi address") {
                    TextField("main.tail1234.ts.net:43210", text: $addressText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Text("In Tailscale, open the device list → your Mac or Distiller → copy DNS name. OpenAGI cannot read the Tailscale app's device list. Wi-Fi discovery requires an OpenAGI announcement on the same network.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button(discovery.searching ? "Searching…" : "Check connection and find servers", systemImage: "network") {
                        discovery.start(addresses: [server, TailscaleServerAddress.parse(addressText)].compactMap { $0 })
                    }.disabled(discovery.searching)
                    if let note = discovery.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(discovery.servers) { candidate in
                        VStack(alignment: .leading) {
                            Text(candidate.name)
                            Text(candidate.address.absoluteString).textSelection(.enabled)
                            Text(candidate.reachable.map { $0 ? "OpenAGI is responding" : "Not reachable · check OpenAGI, Tailscale, DNS, and access rules" } ?? "Nearby announcement or connection check pending")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text("Keep Tailscale and Use Tailscale DNS enabled on both devices. Discovery checks only saved or entered addresses and nearby announcements; it never shares your credentials. Pair a new server from Connection Settings using a one-time code.")
                }
            }
            .navigationTitle("Find servers")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onDisappear { discovery.stop() }
        }
    }
}
