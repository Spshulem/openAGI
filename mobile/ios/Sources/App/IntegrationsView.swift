import SwiftUI

struct IntegrationsView: View {
    @Environment(AppModel.self) private var model
    @State private var integrations: [TaskIntegration] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        List {
            Section {
                Text(model.isOnPhone
                     ? "These optional services use the internet. Your AI model stays on this iPhone when Apple Intelligence is selected."
                     : "Connect task sources to your main agent. Credentials are stored on main.")
                    .foregroundStyle(.secondary)
            }
            if loading { ProgressView("Loading integrations…") }
            if let errorText {
                Section {
                    Text(errorText).foregroundStyle(.red)
                    Button("Retry") { Task { await load() } }
                }
            }
            ForEach(integrations) { integration in
                NavigationLink {
                    TaskIntegrationView(integration: integration)
                } label: {
                    LabeledContent(integration.name, value: integration.configured ? "Connected" : "Not connected")
                }
                .disabled(!integration.available)
                .accessibilityIdentifier("integration-\(integration.id)")
            }
            Section("Other services") {
                Text("Gmail, Google Calendar and messaging services currently require setup on a Mac or server. They aren't available to connect from this app yet.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Integrations")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            integrations = try await model.client.taskIntegrations()
            errorText = nil
        } catch DaemonError.mainConnection(let issue) { errorText = issue.message }
        catch DaemonError.notFound { errorText = "Update OpenAGI on your server to manage integrations here." }
        catch { errorText = "Couldn't load integrations. Check the connection and retry." }
    }
}

private struct TaskIntegrationView: View {
    @Environment(AppModel.self) private var model
    @State var integration: TaskIntegration
    @State private var apiKey = ""
    @State private var working = false
    @State private var status: String?
    @State private var removingKey = false

    var body: some View {
        Form {
            Section {
                LabeledContent("Status", value: integration.configured ? "Connected" : "Not connected")
                if let last = integration.lastSyncedAt {
                    LabeledContent("Last synced") { Text(last, style: .relative) }
                }
            }
            Section {
                SecureField(integration.apiKeySaved ? "Replace API key" : "API key", text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                Button("Save API key") { Task { await save() } }
                    .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Link("Get an API key", destination: URL(string: integration.id == "linear"
                    ? "https://linear.app/settings/api" : "https://app.buildbetter.app")!)
            } footer: {
                Text("Your key is stored on \(model.isOnPhone ? "this iPhone" : "main") and sent only to \(integration.name). Imported tasks stay in OpenAGI after you remove the key.")
            }
            Section {
                Button("Sync tasks now") { Task { await sync() } }
                    .disabled(!integration.configured)
                if let status { Text(status).foregroundStyle(.secondary) }
                if working { ProgressView() }
            }
            if integration.apiKeySaved {
                Section {
                    Button("Remove API key", role: .destructive) { removingKey = true }
                }
            }
        }
        .navigationTitle(integration.name)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(working)
        .confirmationDialog("Remove this API key?", isPresented: $removingKey, titleVisibility: .visible) {
            Button("Remove API key", role: .destructive) { Task { await save(removing: true) } }
        }
    }

    private func save(removing: Bool = false) async {
        working = true
        defer { working = false }
        do {
            let updated = try await model.client.updateTaskIntegration(id: integration.id, apiKey: removing ? nil : apiKey)
            if let saved = updated.first(where: { $0.id == integration.id }) { integration = saved }
            apiKey = ""
            status = removing ? "API key removed." : "Saved. Sync tasks now to check access."
        } catch { status = "Couldn't save the key. Check your connection and try again." }
    }

    private func sync() async {
        working = true
        defer { working = false }
        do {
            let result = try await model.client.syncTaskIntegration(id: integration.id)
            status = result.ok ? "Synced. \(result.created ?? 0) new tasks." : (result.message ?? "Couldn't sync. Check your key and try again.")
            if result.ok { await model.refreshData() }
        } catch { status = "Couldn't sync. Check your connection and try again." }
    }
}
