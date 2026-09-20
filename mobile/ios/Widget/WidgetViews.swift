import SwiftUI
import WidgetKit
import AppIntents

// DESIGN.md: "The widget is the reason this project exists. It is not a
// shrunken app screen." Small shows the count as the hero, then the single
// most urgent task; medium shows up to 3 tasks with working tap-to-complete
// targets. Both carry the "Today" header with the connection dot. No
// shadows, no cards -- just Theme's colours directly on the widget's own
// background.
struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            header
            Group {
                switch entry.state {
                case .unpaired:
                    unpairedView
                case let .empty(headline):
                    emptyView(headline: headline)
                case let .tasks(tasks, counts, ageMinutes):
                    tasksView(tasks: tasks, counts: counts, ageMinutes: ageMinutes)
                case let .stale(ageMinutes):
                    staleView(ageMinutes: ageMinutes)
                case let .unreachable(lastSyncedMinutes):
                    unreachableView(lastSyncedMinutes: lastSyncedMinutes)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.canvas)
    }

    // "Header on both: 'Today' with the connection dot."
    private var header: some View {
        HStack(spacing: Theme.Spacing.x1) {
            Text("Today")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.ink)
            ConnectionDot(state: dotState)
            Spacer(minLength: 0)
        }
    }

    private var dotState: ConnectionDotState {
        switch entry.state {
        case .unreachable: return .failed
        case .stale: return .stale
        case .unpaired, .empty, .tasks: return .fresh
        }
    }

    // No credentials in the Keychain: nothing else in this state is
    // trustworthy, so this is the only thing every widget size renders.
    private var unpairedView: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Image(systemName: "iphone.and.arrow.forward")
                .foregroundStyle(Theme.muted)
            Text("Open OpenAGI to pair this phone.")
                .font(.caption)
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // Either nothing has ever synced, or every task in view is done --
    // either way there's no age to report, since the `.empty` case (unlike
    // `.tasks`/`.stale`/`.unreachable`) carries no snapshot timestamp.
    private func emptyView(headline: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text(headline)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
            Text("Nothing due today.")
                .font(.caption)
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // DESIGN.md: "the widget never renders stale data as though it were
    // current" -- past the hour mark the task list itself is withheld
    // (WidgetState carries no tasks in this case), not merely dimmed.
    private func staleView(ageMinutes: Int) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text("Data is stale")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.ink)
            Text(RelativeTime.lastSynced(minutes: ageMinutes))
                .font(.caption)
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // DESIGN.md copy rule for "Unreachable": state the real reason, plainly,
    // in `alert`. Distinct from `.stale`: this is a known failure, not an
    // unknown age.
    private func unreachableView(lastSyncedMinutes: Int) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text("Can't reach OpenAGI")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.alert)
            Text(RelativeTime.lastSynced(minutes: lastSyncedMinutes))
                .font(.caption)
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func tasksView(tasks: [TaskItem], counts: MobileSummary.Counts, ageMinutes: Int) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            Text("\(counts.today) today")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.ink)
            switch family {
            case .systemSmall:
                if let top = tasks.first {
                    Text(top.title)
                        .font(.caption)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(2)
                }
            case .systemLarge:
                ForEach(tasks.prefix(3)) { task in
                    taskRow(task)
                }
                if counts.pendingActions > 0 {
                    Text("\(counts.pendingActions) pending approval\(counts.pendingActions == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                }
            default: // .systemMedium
                ForEach(tasks.prefix(3)) { task in
                    taskRow(task)
                }
            }
            Spacer(minLength: 0)
            Text(RelativeTime.updated(minutes: ageMinutes))
                .font(.caption2)
                .foregroundStyle(Theme.muted)
        }
    }

    private func taskRow(_ task: TaskItem) -> some View {
        HStack {
            Text(task.title)
                .font(.caption)
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Spacer()
            Button(intent: CompleteTaskIntent(taskID: task.id)) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(Theme.live)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Complete \(task.title)")
        }
    }
}
