import SwiftUI
import Observation

// Setup is descriptive until the person chooses a real setup action. Model
// replies cannot change credentials, pair a server or connect an integration.
@MainActor @Observable
final class SetupGuide {
    struct Message: Identifiable {
        let id = UUID()
        let isUser: Bool
        let text: String
    }
    private(set) var messages: [Message]
    private(set) var isAnswering = false
    var draft = ""
    let availability: OnDeviceModelStatus

    init(availability: OnDeviceModelStatus = .current()) {
        self.availability = availability
        messages = [.init(isUser: false, text: "Hi, I'm OpenAGI. I can help you think things through, remember important details, manage tasks and plan your day."),
                    .init(isUser: false, text: availability == .available
                          ? "Apple Intelligence is ready on this iPhone. Start here with no account, API key or server. Already use OpenAGI on your computer? Connect that server to use its workspace instead."
                          : "You can connect OpenAGI on your computer or server, or run the agent here with a cloud model. Apple Intelligence isn't ready on this iPhone right now.")]
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isAnswering else { return }
        draft = ""
        isAnswering = true
        defer { isAnswering = false }
        // Credentials are entered only in the existing secure setup screens.
        guard !text.contains("sk-") else {
            messages.append(.init(isUser: false, text: "Please enter API keys only in Model Settings. Setup chat doesn't need credentials."))
            return
        }
        messages.append(.init(isUser: true, text: text))
        let lower = text.lowercased()
        let reply: String
        if lower.contains("pair") || lower.contains("server") || lower.contains("computer") {
            reply = "Choose Connect my computer or server below. On your Mac, use OpenAGI → Connect a phone… Or open Nodes → Connect a phone on your main server's dashboard. Use that one-time code in the secure connection screen. On Wi-Fi you can search for an updated server; Tailscale also works with its server address."
        } else if lower.contains("account") || lower.contains("sign up") {
            reply = "You don't need an OpenAGI account to start. Apple Intelligence runs here without signing in. A cloud provider or integration may need its own account; you'll connect those through Settings."
        } else if lower.contains("integrat") || lower.contains("connect") {
            reply = "After setup, open Settings → Integrations to connect supported services. You'll enter credentials in their secure settings, then choose what your agent can do. Nothing is connected just by chatting here."
        } else if availability == .available {
            do {
                let request = DeviceGenerateRequest(id: UUID().uuidString,
                    system: "You explain OpenAGI setup. It is a personal agent for chat, memory, tasks and planning. Apple Intelligence can run locally without an OpenAGI account or key. An existing OpenAGI server can be paired using Connect a phone on Mac or Nodes on its dashboard. Cloud models and integrations are optional and use secure Settings. Explain briefly. Do not claim you completed setup, connected anything, created a task or changed settings. Never request keys, passwords or pairing codes in chat. The buttons perform setup; you have no tools.",
                    messages: messages.suffix(6).map { DeviceModelMessage(role: $0.isUser ? "user" : "assistant", content: $0.text) },
                    tools: [], maxOutputTokens: 256)
                switch try await OnDeviceModelStatus.backend().generate(request, onDelta: { _ in }) {
                case .text(let text): reply = text
                case .toolCall: reply = Self.fallback
                }
            } catch { reply = Self.fallback }
        } else { reply = Self.fallback }
        messages.append(.init(isUser: false, text: reply))
    }

    private static let fallback = "OpenAGI can answer questions, remember things you ask it to keep and help with tasks. Choose this iPhone to start here, or connect your existing computer or server. Integrations are optional and can be added in Settings after setup."
}

struct WelcomeView: View {
    @Environment(AppSession.self) private var session
    @State private var guide = SetupGuide()
    @State private var showSteps = OnDeviceModelStatus.current() != .available
    @FocusState private var composerFocused: Bool

    init(availability: OnDeviceModelStatus = .current(), prefersChat: Bool? = nil) {
        _guide = State(initialValue: SetupGuide(availability: availability))
        _showSteps = State(initialValue: prefersChat.map { !$0 } ?? (availability != .available))
    }

    var body: some View {
        Group {
            if showSteps { StepByStepWelcomeView(showChat: { showSteps = false }) }
            else { guidedSetup }
        }
    }

    private var guidedSetup: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        ForEach(guide.messages) { message in
                            Text(message.text)
                                .textSelection(.enabled)
                                .padding(16)
                                .background(message.isUser ? Color.accentColor.opacity(0.14) : Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 20))
                                .frame(maxWidth: .infinity, alignment: message.isUser ? .trailing : .leading)
                        }
                        if guide.isAnswering { ProgressView("Thinking on this iPhone…") }
                        if let error = session.setupError { Text(error).foregroundStyle(.red) }
                        setupChoices
                        Color.clear.frame(height: 1).id("setup-bottom")
                    }
                    .padding(20)
                    .frame(maxWidth: 600)
                    .frame(maxWidth: .infinity)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: guide.messages.count) { _, _ in proxy.scrollTo("setup-bottom", anchor: .bottom) }
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .bottom) {
                    HStack(alignment: .bottom, spacing: 12) {
                        TextField("Ask about setup", text: $guide.draft, axis: .vertical)
                            .lineLimit(1...4).textFieldStyle(.roundedBorder)
                            .focused($composerFocused)
                            .accessibilityIdentifier("setup-chat-input")
                        Button("Send", systemImage: "arrow.up") { composerFocused = false; Task { await guide.send() } }
                            .labelStyle(.iconOnly).buttonStyle(.borderedProminent).buttonBorderShape(.circle)
                            .disabled(guide.isAnswering || guide.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("setup-chat-send")
                    }
                    .padding().background(.bar)
                }
            }
            .navigationTitle("Meet OpenAGI")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Step-by-step setup") { showSteps = true }.accessibilityIdentifier("setup-use-steps")
                }
                if session.mode != nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Return to app") { session.goBack() } }
                }
            }
            .accessibilityIdentifier("setup-guided-chat")
        }
    }

    private var setupChoices: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button(guide.availability == .available ? "Start with Apple Intelligence" : "Run on this iPhone", systemImage: "iphone") { session.choosePhone() }
                .buttonStyle(.borderedProminent).disabled(!session.canRunOnPhone)
                .accessibilityIdentifier("setup-on-phone")
            Button("Connect my computer or server", systemImage: "server.rack") { session.chooseServer() }
                .buttonStyle(.bordered).accessibilityIdentifier("setup-server")
            Text("You stay in control. Setup chat explains the choices; only your selections connect a model, server or service.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}
