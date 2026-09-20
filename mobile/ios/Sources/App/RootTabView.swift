import SwiftUI

// mobile/FEATURES.md's five destinations. The Inbox badge — "the one number
// worth interrupting someone for" — is the only piece of chrome on this bar
// besides the tab names themselves.
struct RootTabView: View {
    @State private var model: AppModel
    let onRevoked: () -> Void

    init(credentials: Credentials, onRevoked: @escaping () -> Void) {
        _model = State(initialValue: AppModel(credentials: credentials))
        self.onRevoked = onRevoked
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
        .task {
            model.startEventStream()
            await model.refreshInboxCounts()
        }
        .onDisappear { model.stopEventStream() }
    }
}
