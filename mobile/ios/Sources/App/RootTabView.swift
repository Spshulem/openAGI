import SwiftUI

// mobile/FEATURES.md's destinations, five so none fold into More;
// Settings opens from Today's toolbar. The Inbox badge — "the one number
// worth interrupting someone for" — is the only piece of chrome on this bar
// besides the tab names themselves.
struct RootTabView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel
    @AppStorage("workspace.chatPaneOpen") private var chatPaneOpen = false
    let onRevoked: () -> Void
    // A pairing link that arrived while this phone was already paired. It
    // used to be dropped silently: the app stayed on the old daemon, the new
    // code went unspent, and the phone looked "connected but empty" — which is
    // exactly how a phone paired to a scratch daemon could never be moved to
    // the real one. Now it asks, naming both machines.
    let incomingPairing: PairingPayload?
    let onDismissIncomingPairing: () -> Void
    private let currentHost: String
    private let runsBackgroundServices: Bool

    init(
        credentials: Credentials,
        initialTab: AppTab = .today,
        incomingPairing: PairingPayload? = nil,
        onDismissIncomingPairing: @escaping () -> Void = {},
        onRevoked: @escaping () -> Void
    ) {
        let model = AppModel(credentials: credentials)
        model.selectedTab = initialTab
        _model = State(initialValue: model)
        self.incomingPairing = incomingPairing
        self.onDismissIncomingPairing = onDismissIncomingPairing
        self.onRevoked = onRevoked
        self.currentHost = credentials.server.host ?? credentials.server.absoluteString
        self.runsBackgroundServices = true
    }

    #if DEBUG
    init(testingModel: AppModel) {
        _model = State(initialValue: testingModel)
        incomingPairing = nil
        onDismissIncomingPairing = {}
        onRevoked = {}
        currentHost = testingModel.hostLabel
        runsBackgroundServices = false
    }
    #endif

    private var switchAlertShown: Binding<Bool> {
        Binding(
            get: { incomingPairing != nil && !incomingMatchesCurrent },
            set: { if !$0 { onDismissIncomingPairing() } }
        )
    }

    // A link for the daemon this phone is already paired with is not a
    // switch: offering one revoked the working credential before learning the
    // link's one-time code was spent, leaving the phone unpaired. Android
    // drops these the same way.
    private var incomingMatchesCurrent: Bool {
        guard let incomingPairing else { return false }
        return PairingPayload.namesSameDaemon(model.credentials.server, incomingPairing.serverURL)
    }

    var body: some View {
        nativeTabs
        .tint(Theme.live)
        .environment(model)
        .alert("Switch to another OpenAGI?", isPresented: switchAlertShown) {
            Button("Switch", role: .destructive) {
                // The agent on this iPhone is kept, not revoked: connecting to
                // a server is the second step of onboarding, and Settings can
                // switch back.
                if model.isOnPhone {
                    model.detach()
                    AppSession.shared.chooseServer()
                    return
                }
                // Revoke through the model, not locally: it owns the live
                // event stream, which must not outlive this pairing. The
                // incoming link stays set, so the pairing screen that appears
                // next is already filled in — the person still reviews the new
                // address and taps Pair themselves.
                Task {
                    await model.revoke()
                    onRevoked()
                }
            }
            Button("Cancel", role: .cancel) { onDismissIncomingPairing() }
        } message: {
            if model.isOnPhone {
                Text("Connect this iPhone to \(incomingPairing?.serverURL.host ?? "the new address")? The agent on this iPhone is kept, and you can switch back from Settings.")
            } else {
                Text("This phone is connected to \(currentHost). Pairing with \(incomingPairing?.serverURL.host ?? "the new address") disconnects it here.")
            }
        }
        .task {
            if runsBackgroundServices { model.startEventStream() }
            await model.refreshData()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // A `/events` socket iOS cut while suspended can look open for
                // up to its hour-long timeout; reconnect, and its `hello`
                // refreshes the open chats again.
                if runsBackgroundServices { model.startEventStream() }
                model.conversations.resumeOpenChats()
                Task { await model.refreshData() }
            case .background:
                model.conversations.enterBackground()
                model.stopEventStream()
            default:
                break
            }
        }
        .task { if runsBackgroundServices { await PushRegistrar.shared.start() } }
        .onChange(of: PushRouter.shared.wantsSupervisor, initial: true) { _, wants in
            guard wants else { return }
            if let qid = PushRouter.shared.pendingQuestionID {
                model.requestedFocusCardID = qid
                model.requestedOpenContextCardID = qid
                PushRouter.shared.pendingQuestionID = nil
            }
            if let tk = PushRouter.shared.pendingThreadKey {
                model.requestedOpenThreadKey = tk
                PushRouter.shared.pendingThreadKey = nil
            }
            model.bumpFleetGeneration()
            model.requestedChatThread = .supervisor
            model.selectedTab = .chat
            PushRouter.shared.wantsSupervisor = false
        }
        .onChange(of: model.selectedTab, initial: true) { _, nextTab in
            if nextTab == .supervisor {
                model.requestedChatThread = .supervisor
                model.selectedTab = .chat
            }
        }
        .onChange(of: PushRouter.shared.wantsTab, initial: true) { _, tab in
            guard let tab else { return }
            model.selectedTab = tab
            PushRouter.shared.wantsTab = nil
        }
        .task(id: incomingPairing?.serverURL) {
            if incomingMatchesCurrent { onDismissIncomingPairing() }
        }
        // Cancelled with the view, so it stops once this pairing is revoked.
        .task { if runsBackgroundServices { await RefreshCoordinator.sendHeartbeats(client: model.client) } }
        .onDisappear { model.stopEventStream() }
    }

    private var nativeTabs: some View {
        @Bindable var model = model
        return TabView(selection: $model.selectedTab) {
            Tab("Today", systemImage: "sun.max", value: AppTab.today) {
                withSupportingChat(TodayView(onRevoked: onRevoked))
            }
            Tab("Tasks", systemImage: "checklist", value: AppTab.tasks) {
                withSupportingChat(TasksView())
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                withSupportingChat(InboxView())
            }.badge(model.inboxBadgeCount)
            Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: AppTab.chat) { ChatView() }
        }
        // iOS 27.1 places the system tab and navigation bars around Duo's
        // status bar and camera. Keep this same hierarchy across every pose
        // so each destination retains its own NavigationStack and state.
    }

    // The supporting chat splits a tab's own content, never the TabView: the
    // tab rail then always spans the window. Wrapping the whole TabView put
    // it in the left page on Today/Tasks/Inbox and the full window on Chat
    // and Supervisor, so on an unfolded Duo the rail jumped between the
    // hinge and the edge as tabs changed. Chat and Supervisor have no pane:
    // they are a conversation already.
    private func withSupportingChat<Content: View>(_ content: Content) -> some View {
        WorkspaceWithChat(chatPaneOpen: $chatPaneOpen, showsChatPane: true, content: content)
    }
}

private struct WorkspaceWithChat<Content: View>: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.layoutDirection) private var layoutDirection
    @Binding var chatPaneOpen: Bool
    let showsChatPane: Bool
    let content: Content

    var body: some View {
        GeometryReader { geometry in
            let division = DuoLayout.division(in: geometry, layoutDirection: layoutDirection)
            let supportsChat = division != nil || (horizontalSizeClass == .regular && geometry.size.width >= 700)
            WorkspaceLayout(division: division, rightToLeft: layoutDirection == .rightToLeft) {
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .environment(\.workspaceChatToggle, supportsChat ? $chatPaneOpen : nil)
                if supportsChat && showsChatPane && chatPaneOpen {
                    ChatView(onClose: { chatPaneOpen = false })
                        .accessibilityIdentifier("supporting-chat-pane")
                }
            }
        }
    }
}

private struct WorkspaceChatToggleKey: EnvironmentKey {
    static let defaultValue: Binding<Bool>? = nil
}

extension EnvironmentValues {
    var workspaceChatToggle: Binding<Bool>? {
        get { self[WorkspaceChatToggleKey.self] }
        set { self[WorkspaceChatToggleKey.self] = newValue }
    }
}

struct WorkspaceChatToolbar: ToolbarContent {
    @Environment(\.workspaceChatToggle) private var chatPaneOpen

    var body: some ToolbarContent {
        if let chatPaneOpen {
            ToolbarItem(placement: .topBarTrailing) {
                Button(chatPaneOpen.wrappedValue ? "Hide chat" : "Show chat", systemImage: "sidebar.right") {
                    chatPaneOpen.wrappedValue.toggle()
                }
                .accessibilityIdentifier("toggle-chat-pane")
            }
        }
    }
}
