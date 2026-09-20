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

    let onPaired: () -> Void

    init(prefillServer: URL? = nil, prefillCode: String? = nil, onPaired: @escaping () -> Void) {
        _serverText = State(initialValue: prefillServer?.absoluteString ?? "")
        _codeText = State(initialValue: prefillCode ?? "")
        self.onPaired = onPaired
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.x6) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                        Text("Pair with OpenAGI")
                            .font(Theme.Typography.screenTitle)
                            .foregroundStyle(Theme.ink)
                        Text("Your daemon printed a code and its address. Enter both here.")
                            .font(Theme.Typography.secondary)
                            .foregroundStyle(Theme.muted)
                    }

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
        }
    }

    private func pair() async {
        errorHeadline = nil
        errorDetail = nil
        guard let server = URL(string: serverText), server.host != nil else {
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
            // Kick the first refresh so the day's tasks are already on disk
            // by the time the tab bar appears; failure here is not fatal to
            // pairing itself, so it's not surfaced as a pairing error.
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            _ = await RefreshCoordinator(client: client).refresh()
            didPair = true
            onPaired()
        } catch let error as DaemonError {
            (errorHeadline, errorDetail) = Self.message(for: error)
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
    private static func message(for error: DaemonError) -> (headline: String, detail: String) {
        switch error {
        case .unreachableHost(let host) where HostAllowlist.isBlockedByAppTransportSecurity(host):
            return ("That address can't be reached from a phone.",
                    "iOS blocks plain http to Tailscale's 100.x range. Pair using the *.ts.net address instead.")
        case .unreachableHost:
            return ("That address can't be reached from a phone.",
                    "Plain http works only on a tailnet or your home network. Loopback never works — the phone isn't the machine.")
        case .unauthorized:
            return ("That code didn't work.", "Codes last 30 minutes and work once. Run `openagi pair-phone` for a new one.")
        case .conflict:
            return ("This phone is already paired.", "Revoke it from Settings first, then pair again.")
        case .transport:
            return ("Can't reach OpenAGI.", "Check the address and that your phone can reach the daemon.")
        case .notFound, .server, .malformedResponse:
            return ("Pairing failed.", "Try again.")
        }
    }
}
