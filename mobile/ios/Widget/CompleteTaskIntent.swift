import AppIntents
import WidgetKit

// Tapping a task's completion button in the widget runs this in the widget
// extension's own process, in place -- it never launches the app. It goes
// through the same SnapshotStore/OutboundQueue APIs the app uses, which
// route every read-modify-write through CoordinatedFile, because this
// intent's process and the app's process both touch the same App Group
// files with no other synchronization between them.
struct CompleteTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete Task"
    // A tap completes in place; it must not switch the user to the app.
    static let openAppWhenRun = false

    @Parameter(title: "Task ID")
    var taskID: String

    init() {
        self.taskID = ""
    }

    init(taskID: String) {
        self.taskID = taskID
    }

    func perform() async throws -> some IntentResult {
        // Optimistic: hides the row on the widget's *next* redraw. Best
        // effort -- if this write fails the queued op below is still the
        // source of truth for the actual completion.
        _ = try? SnapshotStore().applyOptimisticCompletion(taskID: taskID)
        // Durable: the app's RefreshCoordinator replays this the next time it
        // runs, whether the phone was online for this tap or not.
        try? OutboundQueue().enqueue(PendingOp(kind: .completeTask(taskID)))
        WidgetCenter.shared.reloadTimelines(ofKind: TodayWidgetKind.value)
        return .result()
    }
}
