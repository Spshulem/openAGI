import SwiftUI

// mobile/FEATURES.md's Settings tab: where the agent runs (this iPhone, or a server), the connection (host, node id, last
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
                ScreenHeader(title: "Settings", host: model.hostLabel,
                            ageMinutes: model.ageMinutes, refreshFailed: model.refreshFailed)

                RowGroup {
                    if model.isOnPhone {
                        labeledRow(label: "Runs on", value: "This iPhone", mono: false)
                        RowHairline()
                        labeledRow(label: "Model", value: Self.modelLabel, mono: false)
                    } else {
                        labeledRow(label: "Server", value: model.credentials.server.absoluteString, mono: true)
                        RowHairline()
                        labeledRow(label: "Node ID", value: model.credentials.nodeID, mono: true)
                    }
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

                // Onboarding's second step: the agent starts on this iPhone
                // and can be pointed at a server later, and back again.
                if model.isOnPhone {
                    if let backup = AppSession.shared.serverBackup {
                        SecondaryTextButton(title: "Switch back to \(backup.server.host ?? "the server")") {
                            model.detach()
                            AppSession.shared.switchBackToServer()
                        }
                        .padding(.horizontal, Theme.gutter)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                    }
                    SecondaryTextButton(title: "Connect to a server") {
                        model.detach()
                        AppSession.shared.chooseServer()
                    }
                    .padding(.horizontal, Theme.gutter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Theme.canvas)
                    .listRowSeparator(.hidden)
                } else {
                    if AppSession.shared.canRunOnPhone {
                        SecondaryTextButton(title: AppSession.shared.hasPhoneAgent ? "Use the agent on this iPhone" : "Try the agent on this iPhone") {
                            model.detach()
                            AppSession.shared.tryPhone()
                        }
                        .padding(.horizontal, Theme.gutter)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                    }

                    DestructiveTextButton(title: "Revoke this phone") {
                        showingRevokeConfirmation = true
                    }
                    .disabled(isWorking)
                    .padding(.horizontal, Theme.gutter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Theme.canvas)
                    .listRowSeparator(.hidden)
                }
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

    private static var modelLabel: String {
        switch OnDeviceModelStatus.current() {
        case .available: return "Apple Intelligence"
        case .downloading: return "Downloading"
        case .notEnabled: return "Apple Intelligence is off"
        case .unsupported: return "Not available"
        }
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
