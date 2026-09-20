import SwiftUI

// The main screen once a phone is paired: today's tasks, tappable to
// complete, with a line showing how stale the data is.
struct TodayView: View {
    let credentials: Credentials
    let onRevoked: () -> Void

    @State private var snapshot: Snapshot?
    @State private var isBusy = false
    @State private var lastOutcome: RefreshOutcome?

    private let store = SnapshotStore()
    private let queue = OutboundQueue()

    private var client: DaemonClient {
        DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
    }

    private var coordinator: RefreshCoordinator {
        RefreshCoordinator(client: client, store: store, queue: queue)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(statusLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Today") {
                    let visible = snapshot?.visibleToday ?? []
                    if visible.isEmpty {
                        Text("Nothing due today.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(visible) { task in
                            row(for: task)
                        }
                    }
                }
            }
            .navigationTitle("Today")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink("Settings") {
                        SettingsView(credentials: credentials, onRevoked: onRevoked)
                    }
                }
            }
            .refreshable { await refresh() }
            .task {
                snapshot = store.load()
                await refresh()
            }
        }
    }

    private func row(for task: TaskItem) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                if task.overdue {
                    Text("Overdue")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer()
            Button {
                Task { await complete(task) }
            } label: {
                Image(systemName: "checkmark.circle")
                    .imageScale(.large)
            }
            .buttonStyle(.borderless)
            .disabled(isBusy)
        }
    }

    private var statusLine: String {
        if case .unauthorized = lastOutcome {
            return "Needs re-pairing — revoke and pair again in Settings"
        }
        if case .offline = lastOutcome {
            return "Can't reach OpenAGI"
        }
        guard let snapshot else { return "Not synced yet" }
        let age = snapshot.ageInMinutes()
        return age == 0 ? "Updated just now" : "Updated \(age)m ago"
    }

    private func refresh() async {
        isBusy = true
        defer { isBusy = false }
        lastOutcome = await coordinator.refresh()
        snapshot = store.load()
    }

    // Optimistic: hide the row immediately, queue the completion for the
    // daemon, then try to send it right away without waiting for the next
    // scheduled refresh.
    private func complete(_ task: TaskItem) async {
        isBusy = true
        defer { isBusy = false }
        snapshot = try? store.applyOptimisticCompletion(taskID: task.id)
        try? queue.enqueue(PendingOp(kind: .completeTask(task.id)))
        await coordinator.drainQueue()
    }
}
