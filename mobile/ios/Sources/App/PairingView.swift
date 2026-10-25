import SwiftUI
#if os(iOS)
import UIKit
#endif

// Shown before the phone has any Credentials. A person gets here one of two
// ways: they typed the six-digit code `openagi pair-phone` printed, or they
// tapped the `openagi://pair` link it also printed and the fields below
// arrive prefilled. Either way this view drives the same enrollment.
struct PairingView: View {
    @State private var serverText: String
    @State private var codeText: String
    @State private var isPairing = false
    @State private var didPair = false
    @State private var errorHeadline: String?
    @State private var errorDetail: String?
    @State private var discovery = ServerDiscovery()
    @State private var showingFallback = false
    private let savedServer: URL?
    private let canResumeServer: Bool

    let onCancel: (() -> Void)?
    let onPaired: () -> Void

    init(prefillServer: URL? = nil, prefillCode: String? = nil, onCancel: (() -> Void)? = nil, onPaired: @escaping () -> Void) {
        let backup = Credentials.load(from: .server)
        let candidate = backup ?? Credentials.load()
        let savedServer = candidate.flatMap { $0.isEmbedded ? nil : $0.server }
        self.savedServer = savedServer
        self.canResumeServer = backup != nil && prefillServer == nil
        _serverText = State(initialValue: (prefillServer ?? savedServer)?.absoluteString ?? "")
        _codeText = State(initialValue: prefillCode ?? "")
        self.onCancel = onCancel
        self.onPaired = onPaired
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.x6) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                        Text("Connect to a server")
                            .font(Theme.Typography.screenTitle)
                            .foregroundStyle(Theme.ink)
                        Text("Find your main server, then enter its address and one-time pairing code.")
                            .font(Theme.Typography.secondary)
                            .foregroundStyle(Theme.muted)
                    }

                    if let savedServer {
                        Text("Your saved server is \(savedServer.absoluteString). Opening this screen does not remove its pairing.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if canResumeServer {
                        Button("Return to saved server · no new code needed", systemImage: "server.rack") {
                            Task {
                                isPairing = true
                                defer { isPairing = false }
                                do {
                                    _ = try await AppSession.shared.switchBackToServer()
                                    onPaired()
                                } catch {
                                    errorHeadline = "Can't return to the saved server yet."
                                    errorDetail = "Your pairing is still saved. Check Tailscale and the server connection, then try again."
                                }
                            }
                        }
                        .disabled(isPairing)
                    }
                    Button("Use a local or hosted model", systemImage: "iphone") { showingFallback = true }
                        .buttonStyle(.bordered)
                    Text("Apple Intelligence chat works without a server on supported iPhones with Apple Intelligence enabled.")
                        .font(.footnote).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 8) {
                        Button(discovery.searching ? "Searching…" : "Find servers · Wi-Fi / Tailscale address", systemImage: "network") {
                            discovery.start(addresses: [savedServer, TailscaleServerAddress.parse(serverText)].compactMap { $0 })
                        }
                        .disabled(discovery.searching)
                        ForEach(discovery.servers) { server in
                            Button { serverText = server.address.absoluteString } label: {
                                VStack(alignment: .leading) {
                                    Text(server.name)
                                    Text(server.address.absoluteString).font(.caption)
                                    Text(server.reachable.map { $0 ? "OpenAGI is responding" : "Not reachable · check server and network" } ?? "Nearby announcement or connection check pending")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                        if let note = discovery.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
                        Text("Tailscale does not broadcast servers. In Tailscale, open the device list → your Mac or Distiller → copy DNS name. Enter it below, then tap Find servers. Keep Tailscale and Use Tailscale DNS enabled on both devices.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("How to get a code").font(.headline)
                        Text("On your main server's dashboard, open Nodes → Connect a phone. On Mac, use Connect a phone… in the OpenAGI menu. You can also run this command on main. A worker Mac cannot issue main-server codes. You don't need to copy an auth token.")
                        Text("openagi pair-phone --platform ios").font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                        Text("Codes last 30 minutes and work once. Each phone needs its own code. Enter the server address printed with the code.")
                    }
                    .font(.footnote)

                    RowGroup {
                        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                            Text("Daemon address")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.muted)
                            TextField("http://mac.tail1234.ts.net:43210", text: $serverText)
                                .font(Theme.Typography.dataMono)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                            Text("Use the complete address shown with your code. HTTP and HTTPS can use different ports.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding(Theme.Spacing.x4)
                    }

                    VStack(spacing: Theme.Spacing.x2) {
                        Text("Pairing code")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.muted)
                        TextField("000000", text: $codeText)
                            .font(Theme.Typography.codeEntryMono)
                            .tracking(Theme.codeEntryTracking)
                            .kerning(Theme.codeEntryTracking)
                            .multilineTextAlignment(.center)
                            .keyboardType(.numberPad)
                            .frame(maxWidth: .infinity)
                    }
                    .frame(maxWidth: .infinity)

                    if let errorHeadline {
                        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                            Text(errorHeadline)
                                .font(Theme.Typography.body.weight(.semibold))
                                .foregroundStyle(Theme.alert)
                            if let errorDetail {
                                Text(errorDetail)
                                    .font(Theme.Typography.secondary)
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                    }

                    PrimaryButton(title: didPair ? "Paired" : "Pair", isLoading: isPairing) {
                        Task { await pair() }
                    }
                    .disabled(isPairing || didPair || serverText.isEmpty || codeText.count != 6)
                    .accessibilityLabel(didPair ? "Paired" : "Pair with OpenAGI")
                }
                .padding(Theme.gutter)
            }
            .background(Theme.canvas)
            .sheet(isPresented: $showingFallback) { FallbackChatView() }
            .onDisappear { discovery.stop() }
            .toolbar {
                if let onCancel {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back", action: onCancel).disabled(isPairing)
                    }
                }
            }
        }
    }

    private func pair() async {
        errorHeadline = nil
        errorDetail = nil
        guard let server = TailscaleServerAddress.parse(serverText), server.host != nil else {
            errorHeadline = "That address can't be reached from a phone."
            errorDetail = "Enter the full address the daemon printed, including http:// or https://."
            return
        }
        isPairing = true
        defer { isPairing = false }

        let nodeID = "mobile:" + UUID().uuidString
        let token = Self.generateNodeToken()

        do {
            let enrollment = try await DaemonClient.enroll(
                server: server, code: codeText, nodeID: nodeID, nodeToken: token, name: Self.deviceName()
            )
            let credentials = Credentials(server: server, nodeID: enrollment.node.id, token: enrollment.nodeToken)
            try credentials.save()
            AppSession.shared.prepareForPairing()
            // Kick the first refresh so the day's tasks are already on disk
            // by the time the tab bar appears; failure here is not fatal to
            // pairing itself, so it's not surfaced as a pairing error.
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            _ = await RefreshCoordinator(client: client).refresh()
            didPair = true
            onPaired()
        } catch let error as DaemonError {
            (errorHeadline, errorDetail) = Self.message(for: error, server: server)
        } catch {
            errorHeadline = "Pairing failed."
            errorDetail = error.localizedDescription
        }
    }

    // A 43-character base64url token with no padding: 32 random bytes
    // base64-encode to 44 characters with one trailing `=`, which trimming
    // removes.
    static func generateNodeToken() -> String {
        Data((0..<32).map { _ in UInt8.random(in: 0...255) })
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func deviceName() -> String {
        #if os(iOS)
        UIDevice.current.name
        #else
        "iOS"
        #endif
    }

    // DESIGN.md's copy rules, verbatim where they give exact wording.
    private static func message(for error: DaemonError, server: URL) -> (headline: String, detail: String) {
        switch error {
        case .unreachableHost(let host) where HostAllowlist.isBlockedByAppTransportSecurity(host):
            return ("That address can't be reached from a phone.",
                    "iOS blocks plain http to Tailscale's 100.x range. Pair using the *.ts.net address instead.")
        case .unreachableHost:
            return ("That address can't be reached from a phone.",
                    "Plain http works only on a tailnet or your home network. Loopback never works — the phone isn't the machine.")
        case .unauthorized:
            return ("That code didn't work.", "Codes last 30 minutes and work once. Run openagi pair-phone for a new one.")
        case .conflict:
            return ("This phone is already paired.", "Revoke it from Settings first, then pair again.")
        case .transport(let cause):
            return ("Can't reach OpenAGI.", PairingConnectionFailure.detail(for: cause, server: server))
        case .mainConnection(let issue):
            return ("Main connection needs attention", issue.message)
        case .notFound, .server, .malformedResponse, .agentHostDisabled:
            return ("Pairing failed.", "Try again.")
        }
    }
}
