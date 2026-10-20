import SwiftUI

struct TasksView: View {
    @Environment(AppModel.self) private var model
    @State private var queue: TaskQueue = .user
    @State private var tasksByBucket: [TaskBucket: [TaskRecord]] = [:]
    @State private var isLoading = false
    @State private var hasLoaded = false
    @State private var errorHeadline: String?
    @State private var showingNewTask = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    AgentConnectionRow()
                    Picker("Queue", selection: $queue) {
                        ForEach(TaskQueue.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("tasks-queue")
                }
                if let errorHeadline {
                    Section {
                        Label(errorHeadline, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Button("Retry") { Task { await load() } }
                    }
                }
                if tasksByBucket.values.allSatisfy(\.isEmpty) && errorHeadline == nil {
                    Section {
                        if isLoading || !hasLoaded {
                            ProgressView("Loading tasks…").frame(maxWidth: .infinity)
                        } else {
                            ContentUnavailableView("No tasks in this list", systemImage: "checklist",
                                description: Text("Try the other queue, or check the connected server in Settings. New tasks appear here when you or your agent add them."))
                                .accessibilityIdentifier("tasks-empty")
                        }
                    }
                }
                ForEach(TaskBucket.allCases) { bucket in
                    if let tasks = tasksByBucket[bucket], !tasks.isEmpty {
                        Section(bucket.label) {
                            ForEach(tasks) { task in
                                NavigationLink {
                                    TaskDetailView(task: task, onChanged: {
                                        await load()
                                        model.bumpTasksGeneration()
                                    })
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(task.title).foregroundStyle(.primary)
                                        if isOverdue(task) {
                                            Text("Overdue").font(.caption).foregroundStyle(.red)
                                        }
                                    }
                                }
                                .accessibilityIdentifier("tasks-task-\(task.id)")
                                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                    if !["completed", "cancelled"].contains(task.status) {
                                        Button("Complete", systemImage: "checkmark") {
                                            Task { await complete(task) }
                                        }
                                        .tint(.blue)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .accessibilityIdentifier("tasks-list")
            .navigationTitle("Tasks")
            .refreshable { await load() }
            .task(id: "\(queue.rawValue)-\(model.tasksGeneration)") { await load() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New task", systemImage: "plus") { showingNewTask = true }
                }
            }
            .sheet(isPresented: $showingNewTask) {
                NewTaskSheet { input in
                    try await model.client.createTask(input)
                    await load()
                    model.bumpTasksGeneration()
                }
            }
        }
    }

    private func isOverdue(_ task: TaskRecord) -> Bool {
        guard let due = task.dueDate, !["completed", "cancelled"].contains(task.status) else { return false }
        return due < Date()
    }

    private func complete(_ task: TaskRecord) async {
        do {
            try await model.client.complete(taskID: task.id)
            WidgetReload.reloadToday()
            await load()
            model.bumpTasksGeneration()
        } catch {
            errorHeadline = "Couldn't complete that task. Try again."
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let tasks = try await model.client.tasks(queue: queue.rawValue, limit: Int.max)
            guard !Task.isCancelled else { return }
            tasksByBucket = Dictionary(grouping: tasks) { TaskBucket(rawValue: $0.bucket) ?? .someday }
                .mapValues { $0.sorted { $0.priority > $1.priority } }
            errorHeadline = nil
            hasLoaded = true
        } catch {
            guard !Task.isCancelled else { return }
            if case DaemonError.mainConnection(let issue) = error {
                errorHeadline = issue.message
                return
            }
            errorHeadline = (error as? DaemonError) == .unauthorized
                ? "Pairing needs attention. Connect to your agent again in Settings."
                : "Couldn't load tasks from this server."
        }
    }
}
