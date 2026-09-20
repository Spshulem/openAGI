import SwiftUI

// Shown before the phone has any Credentials. A person gets here one of two
// ways: they typed the six-digit code `openagi pair-phone` printed, or they
// tapped the `openagi://pair` link it also printed and the fields below
// arrive prefilled. Either way this view drives the same enrollment.
struct PairingView: View {
    @State private var serverText: String
    @State private var codeText: String
    @State private var isPairing = false
    @State private var errorMessage: String?

    let onPaired: () -> Void

    init(prefillServer: URL? = nil, prefillCode: String? = nil, onPaired: @escaping () -> Void) {
        _serverText = State(initialValue: prefillServer?.absoluteString ?? "")
        _codeText = State(initialValue: prefillCode ?? "")
        self.onPaired = onPaired
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Daemon address") {
                    TextField("http://mac.tail1234.ts.net:43210", text: $serverText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                Section("Pairing code") {
                    TextField("6-digit code", text: $codeText)
                        .keyboardType(.numberPad)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        Task { await pair() }
                    } label: {
                        if isPairing {
                            ProgressView()
                        } else {
                            Text("Pair")
                        }
                    }
                    .disabled(isPairing || serverText.isEmpty || codeText.count != 6)
                }
            }
            .navigationTitle("Pair with OpenAGI")
        }
    }

    private func pair() async {
        errorMessage = nil
        guard let server = URL(string: serverText), server.host != nil else {
            errorMessage = "Enter the full address the daemon printed, including http:// or https://."
            return
        }
        isPairing = true
        defer { isPairing = false }

        let nodeID = "mobile:" + UUID().uuidString
        let token = Self.generateNodeToken()

        do {
            let enrollment = try await DaemonClient.enroll(
                server: server, code: codeText, nodeID: nodeID, nodeToken: token, name: "iOS"
            )
            let credentials = Credentials(server: server, nodeID: enrollment.node.id, token: enrollment.nodeToken)
            try credentials.save()
            // Kick the first refresh so the day's tasks are already on disk
            // by the time TodayView appears; failure here is not fatal to
            // pairing itself, so it's not surfaced as a pairing error.
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            _ = await RefreshCoordinator(client: client).refresh()
            onPaired()
        } catch let error as DaemonError {
            errorMessage = Self.message(for: error)
        } catch {
            errorMessage = "Could not pair: \(error.localizedDescription)"
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

    private static func message(for error: DaemonError) -> String {
        switch error {
        case .unreachableHost:
            return "OpenAGI can't be reached at that address from a phone. Pair over Tailscale or your home Wi-Fi, not 127.0.0.1."
        case .unauthorized:
            return "That code was rejected. Check it against the daemon and try again."
        case .conflict:
            return "This phone is already paired. Revoke it from Settings first."
        case .transport:
            return "Can't reach OpenAGI. Check the address and that your phone can reach the daemon."
        case .notFound, .server, .malformedResponse:
            return "Pairing failed. Try again."
        }
    }
}
