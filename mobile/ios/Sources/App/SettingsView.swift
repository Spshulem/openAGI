import SwiftUI

// Shows what this phone is paired to and lets a person force a refresh or
// unpair entirely. Never renders the token — only the server and node id are
// shown, matching the rest of the app's rule that the token stays in the
// Keychain and nowhere else, including the screen.
struct SettingsView: View {
    let credentials: Credentials
    let onRevoked: () -> Void

    @State private var isWorking = false

    private var client: DaemonClient {
        DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
    }

    var body: some View {
        Form {
            Section("Paired daemon") {
                LabeledContent("Server", value: credentials.server.absoluteString)
                LabeledContent("Node ID", value: credentials.nodeID)
            }
            Section {
                Button("Refresh now") {
                    Task { await refresh() }
                }
                .disabled(isWorking)
            }
            Section {
                Button("Revoke this phone", role: .destructive) {
                    Task { await revoke() }
                }
                .disabled(isWorking)
            }
        }
        .navigationTitle("Settings")
        .disabled(isWorking)
    }

    private func refresh() async {
        isWorking = true
        defer { isWorking = false }
        _ = await RefreshCoordinator(client: client).refresh()
    }

    private func revoke() async {
        isWorking = true
        defer { isWorking = false }
        // Best-effort: tell the daemon first so it can drop the node
        // immediately, but a phone that can't reach the daemon must still be
        // able to forget its own credential and stop working locally.
        try? await client.revoke()
        Credentials.clear()
        // Both go through their stores' coordinated delete, not a plain
        // FileManager removal: an in-flight refresh() or the widget's
        // AppIntent writing from another process must not be able to
        // silently recreate either file with the just-revoked account's
        // data after this. A queued completion left in the outbox would
        // otherwise survive to replay against whatever account pairs next.
        try? SnapshotStore().delete()
        try? OutboundQueue().clear()
        onRevoked()
    }
}
