import SwiftUI

// A native symbol button with a full-sized touch target.
struct CompletionControl: View {
    let isDone: Bool
    let taskTitle: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .contentTransition(.symbolEffect(.replace))
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.borderless)
        .tint(isDone ? .blue : .secondary)
        .sensoryFeedback(.success, trigger: isDone)
        .accessibilityLabel("Complete \(taskTitle)")
    }
}

// One row shape shared by Today and Tasks: title in body, an optional
// second line ("Overdue" in `alert`, or a bucket label when not today), and
// the completion control on the trailing edge. `isCompleting`/`onComplete`
// are optional so the same row can be used read-only (e.g. inside a
// clarification's linked-task reference) without a control.
struct TaskRow: View {
    let title: String
    let secondaryText: String?
    let secondaryIsAlert: Bool
    var isBusy: Bool = false
    var onComplete: (() -> Void)?

    @State private var isDone = false

    var body: some View {
        HStack(spacing: Theme.Spacing.x3) {
            VStack(alignment: .leading, spacing: Theme.Spacing.x1 / 2) {
                Text(title)
                    .font(Theme.Typography.body)
                    .foregroundStyle(isDone ? Theme.muted : Theme.ink)
                    .strikethrough(isDone)
                    .lineLimit(2)
                if let secondaryText {
                    Text(secondaryText)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(secondaryIsAlert ? Theme.alert : Theme.muted)
                }
            }
            Spacer(minLength: Theme.Spacing.x2)
            if let onComplete {
                CompletionControl(isDone: isDone, taskTitle: title) {
                    isDone = true
                    onComplete()
                }
                .disabled(isBusy || isDone)
            }
        }
        .frame(minHeight: 44)
    }
}

// Native button styles inherit iOS sizing, focus, pressed states and materials.
struct PrimaryButton: View {
    let title: String
    var isLoading: Bool = false
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            button.buttonStyle(.glassProminent).controlSize(.large)
        } else {
            button.buttonStyle(.borderedProminent).controlSize(.large)
        }
    }

    private var button: some View {
        Button(action: action) {
            HStack {
                Spacer()
                if isLoading { ProgressView() } else { Text(title) }
                Spacer()
            }
        }
        .disabled(isLoading)
    }
}

struct DestructiveTextButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, role: .destructive, action: action)
            .buttonStyle(.borderless)
            .frame(maxWidth: .infinity, minHeight: 44)
    }
}

struct SecondaryTextButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .buttonStyle(.borderless)
            .frame(maxWidth: .infinity, minHeight: 44)
    }
}

// Every screen's title + connection line, per DESIGN.md's layout: "Screen
// title / connection line" as the fixed header shape, left-aligned, never
// inside a card.
struct ScreenHeader: View {
    let title: String
    let host: String
    let ageMinutes: Int
    let refreshFailed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text(title)
                .font(Theme.Typography.screenTitle)
                .foregroundStyle(Theme.ink)
            ConnectionLineView(host: host, ageMinutes: ageMinutes, refreshFailed: refreshFailed)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, Theme.Spacing.x2)
        .padding(.bottom, Theme.Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Theme.canvas)
        .listRowSeparator(.hidden)
    }
}

// Connection state describes data refresh, independently of the fleet stream.
struct AgentConnectionRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.hostLabel).font(.subheadline)
                Text(model.dataStatus).font(.caption).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: model.isOnPhone ? "iphone" : "server.rack")
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("agent-connection")
    }
}
