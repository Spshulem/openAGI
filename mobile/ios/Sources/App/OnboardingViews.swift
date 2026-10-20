import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif

// First run: where should the agent run? This iPhone is the default and
// needs nothing else; a server can be added now or later from Settings.
struct WelcomeView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Your personal agent for chat, tasks and memory.")
                }
                Section {
                    Button("On this iPhone", systemImage: "iphone") { session.choosePhone() }
                        .disabled(!session.canRunOnPhone)
                        .accessibilityIdentifier("setup-on-phone")
                } header: {
                    Text("Start locally")
                } footer: {
                    Text(session.canRunOnPhone
                         ? "Use Apple Intelligence on a supported iPhone. No account, API key or server required. Cloud models and online integrations are optional."
                         : "This build doesn't include the on-phone runtime.")
                }
                Section {
                    Button("Connect to a server", systemImage: "server.rack") { session.chooseServer() }
                        .accessibilityIdentifier("setup-server")
                } footer: {
                    Text("Use an existing OpenAGI agent on your Mac or server. You can connect later in Settings.")
                }
            }
            .navigationTitle("OpenAGI")
        }
    }
}

// Setting up the agent on this iPhone: model check, start, name it,
// notifications. Lands in Chat.
struct PhoneSetupView: View {
    @Environment(AppSession.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    private enum Step: Equatable {
        case model
        case starting
        case startFailed(String)
        case name
        case brain
        case notifications
    }

    @State private var step: Step = .model
    @State private var modelStatus = OnDeviceModelStatus.current()
    @State private var credentials: Credentials?
    @State private var name = ""
    @State private var focus = ""
    @State private var isWorking = false
    @State private var errorText: String?
    @State private var showingModelSettings = false

    var body: some View {
        NavigationStack {
            Form {
                    switch step {
                    case .model: modelStep
                    case .starting: startingStep
                    case .startFailed(let message): failedStep(message)
                    case .name: nameStep
                    case .brain: brainStep
                    case .notifications: notificationsStep
                    }
            }
            .navigationTitle("Set up your agent")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { modelStatus = OnDeviceModelStatus.current() }
            }
            .toolbar {
                if step == .model {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back") { session.goBack() }
                    }
                }
            }
            .sheet(isPresented: $showingModelSettings, onDismiss: checkModelReadiness) {
                if let credentials {
                    NavigationStack {
                        ModelSettingsView()
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("Done") { showingModelSettings = false }
                                }
                            }
                    }
                    .environment(AppModel(credentials: credentials))
                }
            }
        }
    }

    // MARK: Steps

    @ViewBuilder private var modelStep: some View {
        header("Check this iPhone", "Use the AI model built into iOS for private, offline replies on supported iPhones, or connect a cloud model.")
        switch modelStatus {
        case .available:
            statusLine("Apple Intelligence is ready.", color: Theme.live)
            PrimaryButton(title: "Continue") { start() }
        case .downloading:
            statusLine("Apple Intelligence is still downloading. Keep the phone on Wi-Fi and charging; this can take a while.", color: Theme.caution)
            SecondaryTextButton(title: "Check again") { modelStatus = OnDeviceModelStatus.current() }
            Button("Use a cloud model instead") { start() }
        case .notEnabled:
            statusLine("Turn on Apple Intelligence in Settings, then come back.", color: Theme.caution)
            PrimaryButton(title: "Open Settings") { openSettings() }
            SecondaryTextButton(title: "Check again") { modelStatus = OnDeviceModelStatus.current() }
            Button("Use a cloud model instead") { start() }
        case .unsupported:
            statusLine("This iPhone can't run Apple's on-device model. OpenAGI can still run here with a Claude or OpenAI key, or your ChatGPT plan.", color: Theme.caution)
            PrimaryButton(title: "Continue with a key or ChatGPT") { start() }
            SecondaryTextButton(title: "Connect to a server instead") { session.chooseServer() }
        }
    }

    @ViewBuilder private var startingStep: some View {
        header("Setting up", "Starting OpenAGI on this iPhone.")
        ProgressView()
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder private func failedStep(_ message: String) -> some View {
        header("OpenAGI couldn't start", message)
        PrimaryButton(title: "Connect to a server instead") { session.chooseServer() }
        SecondaryTextButton(title: "Copy details") { copy(message) }
    }

    @ViewBuilder private var nameStep: some View {
        header("Name your agent", "It'll answer to this name.")
        Section {
                TextField("Name", text: $name)
                    .font(Theme.Typography.body)
                    .textInputAutocapitalization(.words)
                TextField("What do you want help with?", text: $focus, axis: .vertical)
                    .font(Theme.Typography.body)
                    .lineLimit(3...6)
        }
        if let errorText {
            statusLine(errorText, color: Theme.alert)
        }
        PrimaryButton(title: "Continue", isLoading: isWorking) { saveName() }
            .disabled(isWorking || name.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    // A cloud model is optional only when this iPhone has a local model.
    @ViewBuilder private var brainStep: some View {
        header(modelStatus == .available ? "Choose your model" : "Connect a model",
               modelStatus == .available
                ? "Apple Intelligence can chat, remember things and manage your tasks on this iPhone. A cloud model is optional and sends your requests to that provider."
                : "This iPhone needs a Claude or OpenAI key, or ChatGPT sign-in, to reply. Cloud models require an internet connection.")
        if let errorText { statusLine(errorText, color: Theme.alert) }
        if modelStatus == .available {
            Button {
                selectLocalModel()
            } label: {
                HStack {
                    Label("Use Apple Intelligence", systemImage: "apple.intelligence")
                    if isWorking { Spacer(); ProgressView() }
                }
            }
            .disabled(isWorking)
            .accessibilityIdentifier("setup-use-local")
            Text("Inference, tasks and memory stay on this device. Online integrations contact the services you choose to connect.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        Button("Choose a cloud model") {
            errorText = nil
            showingModelSettings = true
        }
        .disabled(isWorking)
    }

    @ViewBuilder private var notificationsStep: some View {
        header("Stay in the loop", "Allow local notifications for a morning plan and evening recap. iOS controls when background refresh can run; open the app to keep them current.")
        PrimaryButton(title: "Turn on notifications") { requestNotifications() }
        SecondaryTextButton(title: "Not now") { finish() }
    }

    // MARK: Actions

    private func checkModelReadiness() {
        guard let credentials else { return }
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
                let settings = try await client.modelSettings()
                guard settings.hasUsableCloudModel else {
                    errorText = "Add a key or finish ChatGPT sign-in, then select that provider to continue."
                    return
                }
                let result = try await client.testModel()
                guard result.ok else {
                    errorText = result.message ?? "The selected model couldn't answer. Check its settings and try again."
                    return
                }
                step = .notifications
            } catch {
                errorText = "Couldn't check the model. Open model settings and try again."
            }
        }
    }

    private func selectLocalModel() {
        guard let credentials else { return }
        errorText = nil
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                modelStatus = OnDeviceModelStatus.current()
                let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
                try await PhoneModelSetup.useLocal(client: client, availability: modelStatus)
                step = .notifications
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func start() {
        step = .starting
        Task {
            do {
                credentials = try await PhoneAgent.bringUp()
                step = .name
            } catch {
                step = .startFailed(error.localizedDescription)
            }
        }
    }

    private func saveName() {
        errorText = nil
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await EmbeddedDaemon.shared.ownerRequest(path: "/persona", body: [
                    "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                    "focus": focus.trimmingCharacters(in: .whitespacesAndNewlines)
                ])
                step = .brain
            } catch {
                errorText = "Couldn't save that. Try again."
            }
        }
    }

    private func requestNotifications() {
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            if let credentials { await PhoneAgent.refreshDigests(credentials) }
            finish()
        }
    }

    private func finish() {
        guard let credentials else { return }
        session.finishPhoneSetup(credentials)
    }

    private func openSettings() {
        #if os(iOS)
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #endif
    }

    private func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #endif
    }

    // MARK: Pieces

    private func header(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text(title)
                .font(Theme.Typography.screenTitle)
                .foregroundStyle(Theme.ink)
            Text(detail)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.muted)
        }
    }

    private func statusLine(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Theme.Typography.body)
            .foregroundStyle(color)
    }
}

// Shown while the agent on this iPhone starts at launch, and if it can't.
struct PhoneStartingView: View {
    @Environment(AppSession.self) private var session
    let failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x6) {
            Spacer()
            if let failure {
                Text("OpenAGI couldn't start")
                    .font(Theme.Typography.screenTitle)
                    .foregroundStyle(Theme.ink)
                Text(failure)
                    .font(Theme.Typography.secondary)
                    .foregroundStyle(Theme.muted)
                    .textSelection(.enabled)
                PrimaryButton(title: "Connect to a server instead") { session.chooseServer() }
            } else {
                ProgressView("Starting OpenAGI")
                    .frame(maxWidth: .infinity)
            }
            Spacer()
        }
        .padding(Theme.gutter)
        .background(Theme.canvas)
    }
}
