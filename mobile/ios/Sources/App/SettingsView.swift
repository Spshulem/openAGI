import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onRevoked: () -> Void

    @State private var path: [WorkspaceDestination] = []
    @State private var isWorking = false
    @State private var showingRevokeConfirmation = false
    @State private var switchError: String?

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                Section {
                    LabeledContent("Runs on", value: model.isOnPhone ? "This iPhone" : "Server")
                    if !model.isOnPhone {
                        LabeledContent("Server") {
                            Text(model.credentials.server.absoluteString)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                    LabeledContent("Data", value: model.dataStatus)
                        .accessibilityIdentifier("settings-data-status")
                    if let issue = model.mainConnectionIssue {
                        Text(issue.message).foregroundStyle(.secondary)
                    }
                    if let fetchedAt = model.snapshot?.fetchedAt {
                        LabeledContent("Last synced") {
                            Text(fetchedAt, style: .relative)
                        }
                    }
                    Button {
                        Task { await refresh() }
                    } label: {
                        HStack {
                            Label("Refresh", systemImage: "arrow.clockwise")
                            Spacer()
                            if isWorking { ProgressView() }
                        }
                    }
                    .disabled(isWorking)
                } header: {
                    Text("Connection")
                } footer: {
                    if !model.isOnPhone {
                        Text("Tasks, Inbox, chat history and agent settings come from main through this server. Supervisor shows the coding fleet on the connected machine.")
                    }
                }

                WorkspaceSection()

                Section("Agent location") {
                    if model.isOnPhone {
                        if let backup = AppSession.shared.serverBackup {
                            Button("Switch back to \(backup.server.host ?? "the server")") {
                                Task { await switchBack() }
                            }
                        }
                        Button("Connect to a server", systemImage: "server.rack", action: connectToServer)
                    } else {
                        Button("Connect to a different server", systemImage: "server.rack", action: connectToServer)
                            .accessibilityIdentifier("settings-change-server")
                        if AppSession.shared.canRunOnPhone {
                            Button(AppSession.shared.hasPhoneAgent ? "Use the agent on this iPhone" : "Try the agent on this iPhone", systemImage: "iphone") {
                                dismiss()
                                model.detach()
                                AppSession.shared.tryPhone()
                            }
                        }
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: Self.buildVersion)
                    if !model.isOnPhone {
                        LabeledContent("Phone ID") {
                            Text(model.credentials.nodeID)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }

                if !model.isOnPhone {
                    Section {
                        Button("Revoke this phone", role: .destructive) {
                            showingRevokeConfirmation = true
                        }
                    }
                }
            }
            .accessibilityIdentifier("settings-form")
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: WorkspaceDestination.self) { destination in
                switch destination {
                case .model: ModelSettingsView()
                case .instructions: InstructionsView()
                case .integrations: IntegrationsView()
                case .skills: SkillsView()
                case .scheduled: ScheduledJobsView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark") { dismiss() }
                        .accessibilityIdentifier("settings-done")
                }
            }
            .disabled(isWorking)
            .alert("Couldn't switch agents", isPresented: Binding(get: { switchError != nil }, set: { if !$0 { switchError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(switchError ?? "")
            }
            .confirmationDialog("Revoke this phone?", isPresented: $showingRevokeConfirmation, titleVisibility: .visible) {
                Button("Revoke", role: .destructive) { Task { await revoke() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This clears the credential, the cached tasks, and anything queued on this phone, and tells the daemon.")
            }
        }
    }

    private static var buildVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private func connectToServer() {
        dismiss()
        model.detach()
        AppSession.shared.chooseServer()
    }

    private func refresh() async {
        isWorking = true
        defer { isWorking = false }
        await model.refreshData()
    }

    private func switchBack() async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await AppSession.shared.switchBackToServer(detaching: model)
        } catch {
            switchError = "Can't reach your server yet. Your work stays on this iPhone until it can."
        }
    }

    private func revoke() async {
        isWorking = true
        defer { isWorking = false }
        await model.revoke()
        onRevoked()
    }
}
