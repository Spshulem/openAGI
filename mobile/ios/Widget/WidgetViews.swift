import SwiftUI
import WidgetKit
import AppIntents

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    var body: some View {
        switch entry.state {
        case .unpaired:
            unpairedView
        case let .empty(headline):
            emptyView(headline: headline)
        case let .tasks(tasks, counts, ageMinutes):
            tasksView(tasks: tasks, counts: counts, ageMinutes: ageMinutes)
        case let .stale(ageMinutes):
            staleView(ageMinutes: ageMinutes)
        }
    }

    // No credentials in the Keychain: nothing else in this state is
    // trustworthy, so this is the only thing every widget size renders.
    private var unpairedView: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: "iphone.and.arrow.forward")
                .imageScale(.large)
                .foregroundStyle(.secondary)
            Text("Not paired")
                .font(.headline)
            Text("Open OpenAGI to pair with your daemon.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // Either nothing has ever synced, or every task in view is done --
    // either way there's no age to report, since the `.empty` case (unlike
    // `.tasks`/`.stale`) carries no snapshot timestamp.
    private func emptyView(headline: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(headline)
                .font(.headline)
                .lineLimit(2)
            Text("Nothing due today.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func staleView(ageMinutes: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Data is stale")
                .font(.headline)
            ageLine(ageMinutes, stale: true)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func tasksView(tasks: [TaskItem], counts: MobileSummary.Counts, ageMinutes: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(counts.today) today")
                .font(.headline)
            switch family {
            case .systemSmall:
                if let top = tasks.first {
                    Text(top.title)
                        .font(.caption)
                        .lineLimit(2)
                }
            case .systemLarge:
                ForEach(tasks.prefix(3)) { task in
                    taskRow(task)
                }
                if counts.pendingActions > 0 {
                    Text("\(counts.pendingActions) pending approval\(counts.pendingActions == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            default: // .systemMedium
                ForEach(tasks.prefix(3)) { task in
                    taskRow(task)
                }
            }
            Spacer(minLength: 0)
            ageLine(ageMinutes, stale: false)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func taskRow(_ task: TaskItem) -> some View {
        HStack {
            Text(task.title)
                .font(.caption)
                .lineLimit(1)
            Spacer()
            Button(intent: CompleteTaskIntent(taskID: task.id)) {
                Image(systemName: "checkmark.circle")
            }
            .buttonStyle(.plain)
        }
    }

    private func ageLine(_ ageMinutes: Int, stale: Bool) -> some View {
        Text(ageMinutes == 0 ? "Updated just now" : "Updated \(ageMinutes)m ago")
            .font(.caption2)
            .foregroundStyle(stale ? .orange : .secondary)
    }
}
