import SwiftUI

struct TodayView: View {
    @Environment(AppModel.self) private var model
    var onRevoked: () -> Void = {}
    @State private var settingsShown = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    AgentConnectionRow()
                }
                if OfflineBanner.isShown(for: model) {
                    Section { OfflineBanner() }
                }
                if let headline = model.snapshot?.summary.brief.headline, !headline.isEmpty {
                    Section {
                        Text(headline).font(.headline)
                    }
                }
                let visible = model.snapshot?.visibleToday ?? []
                if visible.isEmpty {
                    Section { emptyState }
                } else {
                    Section("Today") {
                        ForEach(visible) { task in
                            TaskRow(title: task.title,
                                    secondaryText: task.overdue ? "Overdue" : nil,
                                    secondaryIsAlert: task.overdue,
                                    isBusy: model.isRefreshingToday) {
                                Task { await model.completeToday(taskID: task.id) }
                            }
                            .accessibilityIdentifier("today-task-\(task.id)")
                        }
                    }
                }
                if model.inboxBadgeCount > 0 {
                    Section {
                        Button {
                            model.selectedTab = .inbox
                        } label: {
                            Label("\(model.inboxBadgeCount) waiting on you", systemImage: "tray")
                        }
                        .accessibilityIdentifier("today-open-inbox")
                    }
                }
            }
            .navigationTitle("Today")
            .refreshable { await model.refreshData() }
            .task { await model.refreshToday() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        LifelogView()
                    } label: {
                        Label("Lifelog", systemImage: "waveform")
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        settingsShown = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .accessibilityIdentifier("open-settings")
                }
            }
            .sheet(isPresented: $settingsShown) {
                SettingsView(onRevoked: {
                    settingsShown = false
                    onRevoked()
                })
                .environment(model)
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if model.snapshot == nil && (model.isRefreshingToday || model.lastOutcome == nil) {
            ProgressView("Loading today…").frame(maxWidth: .infinity)
        } else if model.lastOutcome == .unauthorized {
            ContentUnavailableView {
                Label("Pairing needs attention", systemImage: "person.crop.circle.badge.exclamationmark")
            } description: {
                Text("Connect to your agent again to load your work.")
            } actions: {
                Button("Connection Settings") { settingsShown = true }
            }
        } else if model.snapshot == nil && model.refreshFailed {
            ContentUnavailableView {
                Label("Couldn't load Today", systemImage: "wifi.exclamationmark")
            } description: {
                Text("Your agent couldn't be reached.")
            } actions: {
                Button("Retry") { Task { await model.refreshData() } }
            }
        } else {
            ContentUnavailableView {
                Label("No tasks scheduled today", systemImage: "sun.max")
            } description: {
                Text(model.isOnPhone
                     ? "Tasks you add to Today appear here."
                     : "This view shows work stored on \(model.hostLabel). If your tasks are on another agent, connect to that agent in Settings.")
            } actions: {
                Button("All Tasks") { model.selectedTab = .tasks }
                if !model.isOnPhone {
                    Button("Connection Settings") { settingsShown = true }
                }
            }
            .accessibilityIdentifier("today-empty")
        }
    }
}
