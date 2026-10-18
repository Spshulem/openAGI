import SwiftUI

// mobile/FEATURES.md's destinations, five so none fold into More;
// Settings opens from Today's toolbar. The Inbox badge — "the one number
// worth interrupting someone for" — is the only piece of chrome on this bar
// besides the tab names themselves.
struct RootTabView: View {
    @State private var model: AppModel
    let onRevoked: () -> Void
    // A pairing link that arrived while this phone was already paired. It
    // used to be dropped silently: the app stayed on the old daemon, the new
    // code went unspent, and the phone looked "connected but empty" — which is
    // exactly how a phone paired to a scratch daemon could never be moved to
    // the real one. Now it asks, naming both machines.
    let incomingPairing: PairingPayload?
    let onDismissIncomingPairing: () -> Void
    private let currentHost: String

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
    }

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
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            Tab("Today", systemImage: "sun.max", value: AppTab.today) {
                TodayView(onRevoked: onRevoked)
            }
            Tab("Tasks", systemImage: "checklist", value: AppTab.tasks) {
                TasksView()
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                InboxView()
            }
            .badge(model.inboxBadgeCount)
            Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: AppTab.chat) {
                ChatView()
            }
            Tab("Supervisor", systemImage: "binoculars", value: AppTab.supervisor) {
                SupervisorView()
            }
        }
        // Every control that reaches for a system accent (the tab bar's
        // selected state, a Picker's menu label, a Toggle, a Slider) should
        // land on the app's own `live` token rather than the generic system
        // blue -- DESIGN.md's palette is "six values per mode, nothing
        // else."
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
            model.startEventStream()
            await model.refreshInboxCounts()
        }
        .task { await PushRegistrar.shared.start() }
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
        .task { await RefreshCoordinator.sendHeartbeats(client: model.client) }
        .onDisappear { model.stopEventStream() }
    }
}
