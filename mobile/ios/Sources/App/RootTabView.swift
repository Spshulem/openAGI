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
        TabView {
            Tab("Today", systemImage: "sun.max") {
                TodayView()
            }
            Tab("Tasks", systemImage: "checklist") {
                TasksView()
            }
            Tab("Inbox", systemImage: "tray") {
                InboxView()
            }
            .badge(model.inboxBadgeCount)
            Tab("Chat", systemImage: "bubble.left.and.bubble.right") {
                ChatView()
            }
            Tab("Settings", systemImage: "gearshape") {
                SettingsView(onRevoked: onRevoked)
            }
        }
        .environment(model)
        .task {
            model.startEventStream()
            await model.refreshInboxCounts()
        }
        .onDisappear { model.stopEventStream() }
    }
}
