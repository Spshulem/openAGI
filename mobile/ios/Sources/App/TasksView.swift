import SwiftUI

// mobile/FEATURES.md's Tasks tab: "The full manager, not a filtered view."
// Sectioned by bucket, create/edit/delete, complete from any row, filtered
// by queue (yours or the agent's).
struct TasksView: View {
    @Environment(AppModel.self) private var model

    @State private var queue: TaskQueue = .user
    @State private var tasksByBucket: [TaskBucket: [TaskRecord]] = [:]
    @State private var isLoading = false
    @State private var errorHeadline: String?
    @State private var showingNewTask = false
    @AppStorage("collapsedTaskBuckets") private var collapsedBucketsRaw = ""

    private var collapsedBuckets: Set<String> {
        Set(collapsedBucketsRaw.split(separator: ",").map(String.init))
    }

    var body: some View {
        NavigationStack {
            List {
                ScreenHeader(title: "Tasks", host: model.credentials.server.host ?? "",
                            ageMinutes: model.ageMinutes, refreshFailed: model.refreshFailed)

                Picker("Queue", selection: $queue) {
                    ForEach(TaskQueue.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, Theme.Spacing.x2)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Theme.canvas)
                .listRowSeparator(.hidden)

                if let errorHeadline {
                    Text(errorHeadline)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.alert)
                        .padding(.horizontal, Theme.gutter)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }

                if allTasks.isEmpty && !isLoading && errorHeadline == nil {
                    EmptyStateView(headline: "No tasks yet.",
                                  detail: "Add one with the button above, or wait for OpenAGI to add one.")
                        .listRowInsets(EdgeInsets(top: 0, leading: Theme.gutter, bottom: 0, trailing: Theme.gutter))
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }

                ForEach(TaskBucket.allCases) { bucket in
                    if let tasks = tasksByBucket[bucket], !tasks.isEmpty {
                        bucketSection(bucket, tasks: tasks)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .refreshable { await load() }
            .task { await load() }
            .task(id: queue) { await load() }
            .task(id: model.tasksGeneration) { await load() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingNewTask = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New task")
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

    private var allTasks: [TaskRecord] { tasksByBucket.values.flatMap { $0 } }

    private func bucketSection(_ bucket: TaskBucket, tasks: [TaskRecord]) -> some View {
        let isCollapsed = collapsedBuckets.contains(bucket.rawValue)
        return Section {
            if !isCollapsed {
                RowGroup {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        NavigationLink {
                            TaskDetailView(task: task, onChanged: {
                                await load()
                                model.bumpTasksGeneration()
                            })
                        } label: {
                            TaskRow(title: task.title,
                                   secondaryText: secondaryText(for: task, in: bucket),
                                   secondaryIsAlert: isOverdue(task),
                                   isBusy: isLoading,
                                   onComplete: task.status == "completed" ? nil : { Task { await complete(task) } })
                        }
                        .buttonStyle(.plain)
                        if index < tasks.count - 1 { RowHairline() }
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Theme.canvas)
                .listRowSeparator(.hidden)
            }
        } header: {
            Button {
                toggleCollapsed(bucket)
            } label: {
                HStack {
                    Text(bucket.label)
                        .font(Theme.Typography.section)
                        .foregroundStyle(Theme.ink)
                    Text("\(tasks.count)")
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.muted)
                    Spacer()
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, Theme.Spacing.x4)
                .padding(.bottom, Theme.Spacing.x2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(bucket.label), \(tasks.count) tasks, \(isCollapsed ? "collapsed" : "expanded")")
            .listRowInsets(EdgeInsets())
            .textCase(nil)
        }
    }

    private func toggleCollapsed(_ bucket: TaskBucket) {
        var set = collapsedBuckets
        if set.contains(bucket.rawValue) { set.remove(bucket.rawValue) } else { set.insert(bucket.rawValue) }
        collapsedBucketsRaw = set.joined(separator: ",")
    }

    private func isOverdue(_ task: TaskRecord) -> Bool {
        guard let due = task.dueDate, task.status != "completed" else { return false }
        return due < Date()
    }

    private func secondaryText(for task: TaskRecord, in bucket: TaskBucket) -> String? {
        isOverdue(task) ? "Overdue" : nil
    }

    private func complete(_ task: TaskRecord) async {
        do {
            _ = try await model.client.complete(taskID: task.id)
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
            let tasks = try await model.client.tasks(queue: queue.rawValue)
            var grouped: [TaskBucket: [TaskRecord]] = [:]
            for task in tasks {
                let bucket = TaskBucket(rawValue: task.bucket) ?? .someday
                grouped[bucket, default: []].append(task)
            }
            for key in grouped.keys {
                grouped[key]?.sort { $0.priority > $1.priority }
            }
            tasksByBucket = grouped
            errorHeadline = nil
        } catch {
            errorHeadline = "Can't reach OpenAGI."
        }
    }
}
