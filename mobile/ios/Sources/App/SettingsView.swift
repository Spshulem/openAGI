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
        deleteSnapshot()
        onRevoked()
    }

    // SnapshotStore (Task 8) exposes load/save/applyOptimisticCompletion/
    // storeFresh but no delete, and this task's file list does not include
    // modifying it — so this removes the same file SnapshotStore writes to,
    // directly, by the filename SnapshotStore itself uses.
    private func deleteSnapshot() {
        try? FileManager.default.removeItem(at: SharedContainer.url.appending(path: "snapshot.json"))
    }
}
