import SwiftUI

// mobile/FEATURES.md's Settings tab: the connection (host, node id, last
// synced — host and id in mono), refresh now, revoke (confirmation
// required), and a build version so a bug report can name one. Never
// renders the token — only the server and node id are shown, matching the
// rest of the app's rule that the token stays in the Keychain and nowhere
// else, including this screen.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    let onRevoked: () -> Void

    @State private var isWorking = false
    @State private var showingRevokeConfirmation = false

    var body: some View {
        NavigationStack {
            List {
                ScreenHeader(title: "Settings", host: model.credentials.server.host ?? "",
                            ageMinutes: model.ageMinutes, refreshFailed: model.refreshFailed)

                RowGroup {
                    labeledRow(label: "Server", value: model.credentials.server.absoluteString, mono: true)
                    RowHairline()
                    labeledRow(label: "Node ID", value: model.credentials.nodeID, mono: true)
                    RowHairline()
                    labeledRow(label: "Build", value: Self.buildVersion, mono: false)
                }
                .padding(.horizontal, Theme.gutter)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Theme.canvas)
                .listRowSeparator(.hidden)

                PrimaryButton(title: "Refresh now", isLoading: isWorking) {
                    Task { await refresh() }
                }
                .disabled(isWorking)
                .padding(.horizontal, Theme.gutter)
                .padding(.top, Theme.Spacing.x4)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Theme.canvas)
                .listRowSeparator(.hidden)

                DestructiveTextButton(title: "Revoke this phone") {
                    showingRevokeConfirmation = true
                }
                .disabled(isWorking)
                .padding(.horizontal, Theme.gutter)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Theme.canvas)
                .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .disabled(isWorking)
            .confirmationDialog("Revoke this phone?", isPresented: $showingRevokeConfirmation, titleVisibility: .visible) {
                Button("Revoke", role: .destructive) { Task { await revoke() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This clears the credential, the cached tasks, and anything queued on this phone, and tells the daemon.")
            }
        }
    }

    private func labeledRow(label: String, value: String, mono: Bool) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.muted)
            Spacer(minLength: Theme.Spacing.x4)
            Text(value)
                .font(mono ? Theme.Typography.dataMono : Theme.Typography.body)
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, Theme.Spacing.x4)
        .frame(minHeight: Theme.rowMinHeight)
    }

    private static var buildVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private func refresh() async {
        isWorking = true
        defer { isWorking = false }
        await model.refreshToday()
    }

    private func revoke() async {
        isWorking = true
        defer { isWorking = false }
        await model.revoke()
        onRevoked()
    }
}
