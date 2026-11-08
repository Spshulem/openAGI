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
                if let issue = model.mainConnectionIssue {
                    Section {
                        Label("Main connection needs attention", systemImage: "exclamationmark.icloud")
                        Text(issue.message).foregroundStyle(.secondary)
                        Button("Connection Settings") { settingsShown = true }
                        Button("Retry") { Task { await model.refreshData() } }
                    }
                } else if OfflineBanner.isShown(for: model) {
                    Section { OfflineBanner() }
                }
                if let headline = model.snapshot?.summary.brief.headline, !headline.isEmpty {
                    Section {
                        Text(headline).font(.headline)
                    }
                }
                if let review = model.snapshot?.summary.taskReview {
                    Section {
                        if review.status == "reviewed" || review.status == "no_tasks", let date = review.lastReviewedAt {
                            LabeledContent("Task relevance reviewed") { Text(date, style: .relative) }
                        } else {
                            Label(review.status == "unavailable" ? "Task review needs a model" : "Task review couldn't finish",
                                  systemImage: "exclamationmark.clock")
                            Text("Saved tasks remain visible. Refresh syncs the list; it doesn't reassess tasks.")
                                .font(.footnote).foregroundStyle(.secondary)
                            if let date = review.lastReviewedAt {
                                LabeledContent("Last successful review") { Text(date, style: .relative) }
                            }
                        }
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
                WorkspaceChatToolbar()
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
        } else if model.mainConnectionIssue != nil {
            // The connection section above explains the failure, including
            // when an earlier snapshot has real tasks to keep displaying.
            EmptyView()
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
