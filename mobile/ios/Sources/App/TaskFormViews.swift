import SwiftUI

// mobile/FEATURES.md: "Create: title, bucket, priority, optional due date."
struct NewTaskSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreate: (NewTaskInput) async throws -> Void

    @State private var title = ""
    @State private var bucket: TaskBucket = .today
    @State private var priority: Double = 50
    @State private var hasDueDate = false
    @State private var dueDate = Date()
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.x5) {
                    RowGroup {
                        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                            Text("Title").font(Theme.Typography.caption).foregroundStyle(Theme.muted)
                            TextField("What needs doing?", text: $title)
                                .font(Theme.Typography.body)
                        }
                        .padding(Theme.Spacing.x4)
                    }

                    RowGroup {
                        Picker("Bucket", selection: $bucket) {
                            ForEach(TaskBucket.allCases.filter { $0 != .done }) { Text($0.label).tag($0) }
                        }
                        .padding(Theme.Spacing.x4)
                        RowHairline()
                        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                            Text("Priority: \(Int(priority))").font(Theme.Typography.body).foregroundStyle(Theme.ink)
                            Slider(value: $priority, in: 0...100, step: 1)
                        }
                        .padding(Theme.Spacing.x4)
                        RowHairline()
                        Toggle("Due date", isOn: $hasDueDate.animation())
                            .padding(Theme.Spacing.x4)
                        if hasDueDate {
                            DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                                .padding(Theme.Spacing.x4)
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage).font(Theme.Typography.secondary).foregroundStyle(Theme.alert)
                    }

                    PrimaryButton(title: "Create", isLoading: isSaving) {
                        Task { await save() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                }
                .padding(Theme.gutter)
            }
            .background(Theme.canvas)
            .navigationTitle("New task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let input = NewTaskInput(title: title, bucket: bucket, priority: Int(priority),
                                 dueDate: hasDueDate ? dueDate : nil)
        do {
            try await onCreate(input)
            dismiss()
        } catch {
            errorMessage = "Couldn't create that task. Try again."
        }
    }
}

// mobile/FEATURES.md: "Edit: tap a row to open detail — change title,
// bucket, priority, due date, status." Plus complete-from-here and delete
// with confirmation.
struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: TaskRecord
    let onChanged: () async -> Void

    @State private var title: String
    @State private var bucket: TaskBucket
    @State private var status: TaskStatusValue
    @State private var priority: Double
    @State private var hasDueDate: Bool
    @State private var dueDate: Date
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showingDeleteConfirmation = false

    init(task: TaskRecord, onChanged: @escaping () async -> Void) {
        self.task = task
        self.onChanged = onChanged
        _title = State(initialValue: task.title)
        _bucket = State(initialValue: TaskBucket(rawValue: task.bucket) ?? .today)
        _status = State(initialValue: TaskStatusValue(rawValue: task.status) ?? .pending)
        _priority = State(initialValue: Double(task.priority))
        _hasDueDate = State(initialValue: task.dueDate != nil)
        _dueDate = State(initialValue: task.dueDate ?? Date())
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.x5) {
                RowGroup {
                    TextField("Title", text: $title)
                        .font(Theme.Typography.body)
                        .padding(Theme.Spacing.x4)
                    RowHairline()
                    Picker("Bucket", selection: $bucket) {
                        ForEach(TaskBucket.allCases) { Text($0.label).tag($0) }
                    }
                    .padding(Theme.Spacing.x4)
                    RowHairline()
                    Picker("Status", selection: $status) {
                        ForEach(TaskStatusValue.allCases) { Text($0.label).tag($0) }
                    }
                    .padding(Theme.Spacing.x4)
                    RowHairline()
                    VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                        Text("Priority: \(Int(priority))").font(Theme.Typography.body).foregroundStyle(Theme.ink)
                        Slider(value: $priority, in: 0...100, step: 1)
                    }
                    .padding(Theme.Spacing.x4)
                    RowHairline()
                    Toggle("Due date", isOn: $hasDueDate.animation())
                        .padding(Theme.Spacing.x4)
                    if hasDueDate {
                        DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                            .padding(Theme.Spacing.x4)
                    }
                }
                .padding(.horizontal, Theme.gutter)

                if let errorMessage {
                    Text(errorMessage).font(Theme.Typography.secondary).foregroundStyle(Theme.alert)
                        .padding(.horizontal, Theme.gutter)
                }

                VStack(spacing: Theme.Spacing.x2) {
                    PrimaryButton(title: "Save", isLoading: isSaving) { Task { await save() } }
                    if task.status != "completed" {
                        PrimaryButton(title: "Complete") { Task { await complete() } }
                    }
                    DestructiveTextButton(title: "Delete") { showingDeleteConfirmation = true }
                }
                .padding(.horizontal, Theme.gutter)
                .disabled(isSaving)
            }
            .padding(.vertical, Theme.Spacing.x5)
        }
        .background(Theme.canvas)
        .navigationTitle("Edit task")
        .confirmationDialog("Delete this task?", isPresented: $showingDeleteConfirmation, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let patch = TaskPatch(title: title, bucket: bucket, priority: Int(priority),
                              dueDate: .some(hasDueDate ? dueDate : nil), status: status)
        do {
            _ = try await model.client.updateTask(id: task.id, patch: patch)
            await onChanged()
            dismiss()
        } catch {
            errorMessage = "Couldn't save. Try again."
        }
    }

    private func complete() async {
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await model.client.complete(taskID: task.id)
            WidgetReload.reloadToday()
            await onChanged()
            dismiss()
        } catch {
            errorMessage = "Couldn't complete that task. Try again."
        }
    }

    private func delete() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await model.client.deleteTask(id: task.id)
            await onChanged()
            dismiss()
        } catch {
            errorMessage = "Couldn't delete that task. Try again."
        }
    }
}
