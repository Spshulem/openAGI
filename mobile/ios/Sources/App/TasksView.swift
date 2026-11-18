import SwiftUI

struct TasksView: View {
    @Environment(AppModel.self) private var model
    @State private var queue: TaskQueue = .user
    private var tasksByBucket: [TaskBucket: [TaskRecord]] {
        Dictionary(grouping: model.workspace.tasks[queue.rawValue] ?? []) { TaskBucket(rawValue: $0.bucket) ?? .someday }
            .mapValues { $0.sorted { $0.priority > $1.priority } }
    }
    private var isLoading: Bool { model.loadingQueues.contains(queue.rawValue) }
    private var hasLoaded: Bool { model.workspace.tasks[queue.rawValue] != nil }
    private var errorHeadline: String? { actionError ?? model.tasksErrors[queue.rawValue] }
    @State private var actionError: String?
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
                        Button("Retry") { Task { await load(force: true) } }
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
                                        model.bumpTasksGeneration()
                                        await load()
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
            .refreshable { await load(force: true) }
            .task(id: "\(queue.rawValue)-\(model.tasksGeneration)") { await load() }
            .toolbar {
                WorkspaceChatToolbar()
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New task", systemImage: "plus") { showingNewTask = true }
                }
            }
            .sheet(isPresented: $showingNewTask) {
                NewTaskSheet { input in
                    try await model.client.createTask(input)
                    model.bumpTasksGeneration()
                    await load()
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
            model.bumpTasksGeneration()
            await load()
        } catch {
            actionError = "Couldn't complete that task. Try again."
        }
    }

    private func load(force: Bool = false) async {
        actionError = nil
        await model.refreshTasks(queue: queue, force: force)
    }
}
