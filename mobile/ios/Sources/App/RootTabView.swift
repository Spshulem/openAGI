import SwiftUI

// mobile/FEATURES.md's five destinations. The Inbox badge — "the one number
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
        incomingPairing: PairingPayload? = nil,
        onDismissIncomingPairing: @escaping () -> Void = {},
        onRevoked: @escaping () -> Void
    ) {
        _model = State(initialValue: AppModel(credentials: credentials))
        self.incomingPairing = incomingPairing
        self.onDismissIncomingPairing = onDismissIncomingPairing
        self.onRevoked = onRevoked
        self.currentHost = credentials.server.host ?? credentials.server.absoluteString
    }

    private var switchAlertShown: Binding<Bool> {
        Binding(
            get: { incomingPairing != nil },
            set: { if !$0 { onDismissIncomingPairing() } }
        )
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
                TodayView()
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
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                SettingsView(onRevoked: onRevoked)
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
            Text("This phone is connected to \(currentHost). Pairing with \(incomingPairing?.serverURL.host ?? "the new address") disconnects it here.")
        }
        .task {
            model.startEventStream()
            await model.refreshInboxCounts()
        }
        .onDisappear { model.stopEventStream() }
    }
}
