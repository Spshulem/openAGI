import SwiftUI

// mobile/FEATURES.md's destinations, five so none fold into More;
// Settings opens from Today's toolbar. The Inbox badge — "the one number
// worth interrupting someone for" — is the only piece of chrome on this bar
// besides the tab names themselves.
struct RootTabView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.verticalSizeClass) private var verticalSizeClass
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
        // Declaring `@Bindable` locally (rather than storing the model as
        // `@Bindable` itself) is the documented way to get a two-way
        // `Binding` out of an `@Observable` reference type held in `@State`
        // -- needed so Today's "N waiting on you" row (DESIGN.md's "Screens
        // must not be mostly empty" section) can switch this tab bar to
        // Inbox by setting `model.selectedTab` from anywhere behind it.
        GeometryReader { geometry in
            if geometry.size.width >= 760 && verticalSizeClass != .compact {
                HStack(spacing: 0) {
                    workspaceDestination
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if chatPaneOpen && model.selectedTab != .chat {
                        Divider()
                        ChatView(onClose: { chatPaneOpen = false })
                            .frame(width: max(320, (geometry.size.width - 88) * 0.42))
                            .accessibilityIdentifier("supporting-chat-pane")
                    }
                    Divider()
                    rightNavigation
                }
            } else {
                compactTabs
            }
        }
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
            await model.refreshInboxCounts()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await model.refreshData() }
            }
        }
        .task { if runsBackgroundServices { await PushRegistrar.shared.start() } }
        .onChange(of: PushRouter.shared.wantsSupervisor, initial: true) { _, wants in
            guard wants else { return }
            model.selectedTab = .supervisor
            PushRouter.shared.wantsSupervisor = false
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

    @ViewBuilder private var workspaceDestination: some View {
        switch model.selectedTab {
        case .today: TodayView(onRevoked: onRevoked)
        case .tasks: TasksView()
        case .inbox: InboxView()
        case .chat: ChatView()
        case .supervisor: SupervisorView(showsInlineChat: false)
        }
    }

    private var compactTabs: some View {
        @Bindable var model = model
        return TabView(selection: $model.selectedTab) {
            Tab("Today", systemImage: "sun.max", value: AppTab.today) { TodayView(onRevoked: onRevoked) }
            Tab("Tasks", systemImage: "checklist", value: AppTab.tasks) { TasksView() }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) { InboxView() }.badge(model.inboxBadgeCount)
            Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: AppTab.chat) { ChatView() }
            Tab("Supervisor", systemImage: "binoculars", value: AppTab.supervisor) { SupervisorView() }
        }
    }

    private var rightNavigation: some View {
        ScrollView {
            VStack(spacing: 12) {
                ForEach([AppTab.today, .tasks, .inbox, .chat, .supervisor], id: \.self) { tab in
                    Button { model.selectedTab = tab } label: {
                        VStack(spacing: 5) {
                            Image(systemName: tab.navigationSymbol).font(.title3)
                            Text(tab.navigationTitle).font(.caption)
                            if tab == .inbox && model.inboxBadgeCount > 0 {
                                Text("\(model.inboxBadgeCount)").font(.caption2).bold()
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .tint(model.selectedTab == tab ? Color.accentColor : .secondary)
                    .accessibilityLabel(tab.navigationTitle)
                    .accessibilityAddTraits(model.selectedTab == tab ? .isSelected : [])
                }
                if model.selectedTab != .chat {
                    Divider()
                    Button(chatPaneOpen ? "Hide chat" : "Show chat", systemImage: "sidebar.right") {
                        chatPaneOpen.toggle()
                    }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("toggle-chat-pane")
                }
            }
            .padding(.vertical)
        }
        .frame(width: 88)
        .background(.regularMaterial)
        .accessibilityIdentifier("right-navigation")
    }
}

private extension AppTab {
    var navigationTitle: String {
        switch self {
        case .today: "Today"
        case .tasks: "Tasks"
        case .inbox: "Inbox"
        case .chat: "Chat"
        case .supervisor: "Supervisor"
        }
    }
    var navigationSymbol: String {
        switch self {
        case .today: "sun.max"
        case .tasks: "checklist"
        case .inbox: "tray"
        case .chat: "bubble.left.and.bubble.right"
        case .supervisor: "binoculars"
        }
    }
}
