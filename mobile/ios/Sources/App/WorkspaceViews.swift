import SwiftUI

// Settings' Workspace section: the agent's model, instructions, skills and
// scheduled jobs, on whichever daemon this app is using (the one on this
// iPhone or a paired Mac). Spec: docs/superpowers/specs/
// 2026-10-16-openagi-phone-workspace-design.md.

enum WorkspaceDestination: String, CaseIterable, Hashable, Identifiable {
    case model, instructions, integrations, skills, scheduled

    var id: String { rawValue }
    var title: String {
        switch self {
        case .model: "Model"
        case .instructions: "Instructions"
        case .integrations: "Integrations"
        case .skills: "Skills"
        case .scheduled: "Scheduled"
        }
    }
    var symbol: String {
        switch self {
        case .model: "brain"
        case .instructions: "text.page"
        case .integrations: "link"
        case .skills: "wrench.and.screwdriver"
        case .scheduled: "calendar.badge.clock"
        }
    }
}

struct WorkspaceSection: View {
    var body: some View {
        Section("Agent") {
            ForEach(WorkspaceDestination.allCases) { destination in
                NavigationLink(value: destination) {
                    Label(destination.title, systemImage: destination.symbol)
                }
                .accessibilityIdentifier("settings-\(destination.rawValue)")
            }
        }
    }
}

// MARK: - Model

struct ModelSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var settings: ModelSettings?
    @State private var isLoading = false
    @State private var showingDirectChat = false
    @State private var anthropicKey = ""
    @State private var openaiKey = ""
    @State private var anthropicModel = ""
    @State private var openaiModel = ""
    @State private var isWorking = false
    @State private var status: (text: String, isError: Bool)?

    private var choices: [(id: String, label: String)] {
        var list = [("auto", "Automatic"), ("anthropic", "Claude"), ("openai", "OpenAI"), ("chatgpt", "ChatGPT")]
        if model.isOnPhone { list.append(("on-device", "Apple Intelligence")) }
        return list
    }

    var body: some View {
        Form {
            if let settings {
                Section {
                    Picker("Use", selection: Binding(
                        get: { settings.preference },
                        set: { choice in Task { await save(ModelSettingsUpdate(preference: choice)) } }
                    )) {
                        ForEach(choices, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("model-provider")
                    LabeledContent("Now answering", value: activeLabel(settings))
                        .accessibilityIdentifier("model-active")
                } footer: {
                    Text(model.isOnPhone
                         ? "Apple Intelligence keeps model requests on this iPhone. Automatic can use saved cloud keys or ChatGPT sign-in. Cloud models send requests to that provider and can fall back to this iPhone when offline."
                         : "Automatic uses Claude when its key is set, then OpenAI.")
                }

                keySection(title: "Claude", configured: settings.providers.anthropic.configured,
                           key: $anthropicKey, modelName: $anthropicModel,
                           modelPlaceholder: settings.providers.anthropic.model ?? "claude-sonnet-4-6",
                           keyField: "anthropicKey", modelField: "anthropicModel",
                           help: "Create a key at console.anthropic.com.")

                keySection(title: "OpenAI", configured: settings.providers.openai.configured,
                           key: $openaiKey, modelName: $openaiModel,
                           modelPlaceholder: settings.providers.openai.model ?? "gpt-5",
                           keyField: "openaiKey", modelField: "openaiModel",
                           help: "Create a key at platform.openai.com.")

                // ChatGPT's sign-in returns to the machine running the
                // browser, so a Mac signs in on its own setup page.
                if let chatgpt = settings.providers.chatgpt {
                    if model.isOnPhone {
                        ChatGPTSignInSection(signedIn: chatgpt.signedIn, email: chatgpt.email) { await reload() }
                    } else {
                        Section {
                            LabeledContent("ChatGPT", value: chatgpt.signedIn ? (chatgpt.email ?? "Signed in") : "Not signed in")
                            if chatgpt.signedIn {
                                Button("Use ChatGPT") { Task { await save(ModelSettingsUpdate(preference: "chatgpt")) } }
                            }
                        } footer: {
                            Text("To sign in with ChatGPT, open OpenAGI's setup page on your Mac.")
                        }
                    }
                }

                Section {
                    Button("Test the model") { Task { await test() } }
                        .disabled(isWorking)
                        .accessibilityIdentifier("model-test")
                    if let status {
                        Text(status.text)
                            .font(Theme.Typography.secondary)
                            .foregroundStyle(status.isError ? Theme.alert : Theme.live)
                    }
                }
            } else if let status, !isLoading {
                ContentUnavailableView {
                    Label("Model settings unavailable", systemImage: "cpu")
                } description: {
                    Text(status.text)
                } actions: {
                    Button("Retry") { Task { await reload() } }
                        .accessibilityIdentifier("model-retry")
                }
            } else {
                ProgressView("Loading models…")
            }
            Section {
                Button("Chat without server", systemImage: "iphone") { showingDirectChat = true }
                    .accessibilityIdentifier("model-direct-chat")
            } footer: {
                Text("Use Apple Intelligence or a provider key saved on this iPhone in a separate chat. Your paired agent and its model stay saved.")
            }
        }
        .accessibilityIdentifier("model-form")
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isWorking)
        .task { await reload() }
        .refreshable { await reload() }
        .sheet(isPresented: $showingDirectChat) { FallbackChatView() }
    }

    @ViewBuilder
    private func keySection(title: String, configured: Bool, key: Binding<String>, modelName: Binding<String>,
                            modelPlaceholder: String, keyField: String, modelField: String, help: String) -> some View {
        Section {
            SecureField(configured ? "Key saved. Paste a new one to replace it." : "API key", text: key)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField(modelPlaceholder, text: modelName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(Theme.Typography.dataMono)
            Button("Save") {
                var update = ModelSettingsUpdate()
                let trimmedKey = key.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedModel = modelName.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedKey.isEmpty { keyField == "anthropicKey" ? (update.anthropicKey = trimmedKey) : (update.openaiKey = trimmedKey) }
                if !trimmedModel.isEmpty { modelField == "anthropicModel" ? (update.anthropicModel = trimmedModel) : (update.openaiModel = trimmedModel) }
                Task {
                    if await save(update) { key.wrappedValue = "" }
                }
            }
            .disabled(key.wrappedValue.isEmpty && modelName.wrappedValue.isEmpty)
            if configured {
                Button("Remove key", role: .destructive) { Task { await save(ModelSettingsUpdate(clear: [keyField])) } }
            }
        } header: {
            HStack {
                Text(title)
                if configured { Text("· key saved").foregroundStyle(Theme.live) }
            }
        } footer: {
            Text(help)
        }
    }

    private func activeLabel(_ settings: ModelSettings) -> String {
        let name: String
        switch settings.active.provider {
        case "anthropic": name = "Claude"
        case "openai": name = "OpenAI"
        case "chatgpt": name = "ChatGPT"
        case "on-device": return "This iPhone's model"
        case "none", nil: return "No model set up"
        default: name = settings.active.provider ?? "Model"
        }
        return [name, settings.active.model].compactMap { $0 }.joined(separator: " · ")
    }

    private func reload() async {
        guard !isLoading else { return }
        isLoading = true
        status = nil
        defer { isLoading = false }
        do {
            settings = try await model.client.modelSettings()
        } catch is CancellationError {
            return
        } catch {
            status = (ModelSettingsErrorCopy.message(for: error), true)
        }
    }

    @discardableResult
    private func save(_ update: ModelSettingsUpdate) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            settings = try await model.client.updateModelSettings(update)
            status = ("Saved.", false)
            return true
        } catch {
            status = (ModelSettingsErrorCopy.message(for: error), true)
            return false
        }
    }

    private func test() async {
        isWorking = true
        defer { isWorking = false }
        status = ("Asking the model…", false)
        do {
            let result = try await model.client.testModel()
            status = result.ok
                ? ("Works. \(result.model ?? "The model") answered.", false)
                : (result.message ?? "The model didn't answer.", true)
        } catch {
            status = (ModelSettingsErrorCopy.message(for: error), true)
        }
    }
}

enum ModelSettingsErrorCopy {
    static func message(for error: Error) -> String {
        guard let error = error as? DaemonError else { return "Couldn't reach your agent. Check its connection, then retry." }
        switch error {
        case .notFound:
            return "Your server needs an OpenAGI update to load and select models here. Update the main server, then retry. Your pairing is saved."
        case .mainConnection(let issue): return issue.message
        case .unauthorized:
            return "Your server didn't authorize model settings. Check its version and this phone's access in Connection Settings, then retry."
        case .malformedResponse:
            return "Your server returned model settings this app couldn't read. Update OpenAGI on the main server, then retry."
        default: return "Couldn't reach your agent. Check its connection, then retry."
        }
    }
}

// MARK: - Instructions

struct InstructionsView: View {
    @Environment(AppModel.self) private var model
    @State private var markdown = ""
    @State private var loaded = false
    @State private var isSaving = false
    @State private var status: (text: String, isError: Bool)?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            Text("Who your agent is and how it should work. It reads this before every conversation.")
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.muted)
            TextEditor(text: $markdown)
                .font(Theme.Typography.body)
                .scrollContentBackground(.hidden)
                .padding(Theme.Spacing.x2)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowGroupRadius, style: .continuous))
                .disabled(!loaded)
            if let status {
                Text(status.text)
                    .font(Theme.Typography.secondary)
                    .foregroundStyle(status.isError ? Theme.alert : Theme.live)
            }
        }
        .padding(Theme.gutter)
        .background(Theme.canvas)
        .navigationTitle("Instructions")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(!loaded || isSaving || markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task {
            do {
                markdown = try await model.client.persona().markdown
                if markdown.isEmpty { markdown = "# My agent\n\nName: \n\nWhat I help with: \n" }
                loaded = true
            } catch {
                status = ("Couldn't load the instructions.", true)
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await model.client.savePersona(markdown: markdown)
            status = ("Saved\(saved.name.map { ". Your agent is \($0)." } ?? ".")", false)
        } catch {
            status = ("Couldn't save. Try again.", true)
        }
    }
}

// MARK: - Skills

struct SkillsView: View {
    @Environment(AppModel.self) private var model
    @State private var skills: [SkillSummary] = []
    @State private var loadFailed = false
    @State private var showingNew = false

    var body: some View {
        List {
            Section {
                ForEach(skills) { skill in
                    NavigationLink {
                        SkillEditorView(existingName: skill.name) { await reload() }
                            .environment(model)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(skill.name).font(Theme.Typography.body)
                                if !skill.editable {
                                    Text("built-in").font(Theme.Typography.caption).foregroundStyle(Theme.muted)
                                }
                            }
                            if !skill.description.isEmpty {
                                Text(skill.description)
                                    .font(Theme.Typography.secondary)
                                    .foregroundStyle(Theme.muted)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            } footer: {
                Text(loadFailed
                     ? "Couldn't load skills."
                     : "A skill is a reusable set of instructions your agent can run, like \"plan my week\". Ask for one in chat, or add it here.")
            }
        }
        .navigationTitle("Skills")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New skill")
            }
        }
        .navigationDestination(isPresented: $showingNew) {
            SkillEditorView(existingName: nil) { await reload() }
                .environment(model)
        }
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            skills = try await model.client.skills()
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }
}

struct SkillEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let existingName: String?
    let onChange: () async -> Void

    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var editable = true
    @State private var isWorking = false
    @State private var errorText: String?
    @State private var confirmingDelete = false

    var body: some View {
        Form {
            Section {
                if existingName == nil {
                    TextField("Name, like plan-my-week", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(Theme.Typography.dataMono)
                } else {
                    Text(name).font(Theme.Typography.dataMono)
                }
                TextField("What it does", text: $description, axis: .vertical)
                    .lineLimit(1...3)
            }
            Section {
                TextEditor(text: $instructions)
                    .frame(minHeight: 220)
                    .font(Theme.Typography.body)
            } header: {
                Text("Instructions")
            } footer: {
                Text("Write it like a note to a capable assistant. {{input}} is replaced with what you ask for when you run it.")
            }
            if let errorText {
                Text(errorText).foregroundStyle(Theme.alert)
            }
            if existingName != nil, editable {
                Section {
                    Button("Delete skill", role: .destructive) { confirmingDelete = true }
                }
            }
        }
        .disabled(!editable || isWorking)
        .navigationTitle(existingName == nil ? "New skill" : "Skill")
        .toolbar {
            if editable {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(SkillName.slug(name).isEmpty || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .confirmationDialog("Delete this skill?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        }
        .task {
            guard let existingName else { return }
            name = existingName
            do {
                let skill = try await model.client.skill(named: existingName)
                description = skill.description
                instructions = skill.instructions
                editable = skill.editable
                if !editable { errorText = "Built-in skills can't be changed here." }
            } catch {
                errorText = "Couldn't load this skill."
            }
        }
    }

    private func save() async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client.saveSkill(name: SkillName.slug(name), description: description, instructions: instructions)
            await onChange()
            dismiss()
        } catch DaemonError.conflict {
            errorText = "A built-in skill already has that name. Pick another."
        } catch {
            errorText = "Couldn't save. Try again."
        }
    }

    private func delete() async {
        guard let existingName else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await model.client.deleteSkill(name: existingName)
            await onChange()
            dismiss()
        } catch {
            errorText = "Couldn't delete. Try again."
        }
    }
}

// MARK: - Scheduled jobs

struct ScheduledJobsView: View {
    @Environment(AppModel.self) private var model
    @State private var jobs: [ScheduledJob] = []
    @State private var loadFailed = false

    var body: some View {
        List {
            Section {
                ForEach(jobs) { job in
                    Toggle(isOn: Binding(
                        get: { job.enabled },
                        set: { enabled in Task { await set(job, enabled: enabled) } }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(job.name).font(Theme.Typography.body)
                            Text(job.scheduleLabel)
                                .font(Theme.Typography.secondary)
                                .foregroundStyle(Theme.muted)
                        }
                    }
                }
            } footer: {
                Text(loadFailed ? "Couldn't load scheduled jobs." : "What your agent runs on its own. On this iPhone, jobs run when iOS lets the app refresh.")
            }
        }
        .navigationTitle("Scheduled")
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            jobs = try await model.client.scheduledJobs()
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    private func set(_ job: ScheduledJob, enabled: Bool) async {
        try? await model.client.setJob(id: job.id, enabled: enabled)
        await reload()
    }
}

// MARK: - Sign in with ChatGPT

// Runs on the owner's ChatGPT Plus or Pro plan instead of an API key. The
// daemon does the OAuth exchange and keeps the tokens; the phone only opens
// the sign-in page and waits for the daemon's callback to hand control back
// on the openagi:// scheme.
struct ChatGPTSignInSection: View {
    @Environment(AppModel.self) private var model
    let signedIn: Bool
    let email: String?
    let onChange: () async -> Void
    @State private var errorText: String?
    @State private var isWorking = false

    var body: some View {
        Section {
            if signedIn {
                LabeledContent("Signed in", value: email ?? "ChatGPT")
                Button("Use ChatGPT") { Task { await use() } }
                Button("Sign out", role: .destructive) { Task { await signOut() } }
            } else {
                Button("Sign in with ChatGPT") { Task { await signIn() } }
                    .disabled(isWorking)
            }
            if let errorText {
                Text(errorText).font(Theme.Typography.secondary).foregroundStyle(Theme.alert)
            }
        } header: {
            Text("ChatGPT")
        } footer: {
            Text("Uses your ChatGPT Plus or Pro plan instead of an API key, up to the weekly limit you set when you sign in.")
        }
    }

    private func signIn() async {
        isWorking = true
        defer { isWorking = false }
        errorText = nil
        do {
            let url = try await model.client.startChatGPTSignIn()
            let callback = try await WebSignIn.run(url: url, callbackScheme: "openagi")
            if let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "error" })?.value {
                errorText = "Sign-in didn't finish (\(code))."
            }
            await onChange()
        } catch WebSignIn.Cancelled.cancelled {
            // The person closed the sheet.
        } catch {
            errorText = "Couldn't start sign-in. Try again."
        }
    }

    private func use() async {
        _ = try? await model.client.updateModelSettings(ModelSettingsUpdate(preference: "chatgpt"))
        await onChange()
    }

    private func signOut() async {
        try? await model.client.signOutChatGPT()
        await onChange()
    }
}
