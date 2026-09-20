import SwiftUI

// DESIGN.md's one deliberately spent animation budget: "The control fills
// with `live`, a checkmark draws, the row's text dims, and the row collapses
// out of the list over ~260ms. That is the only animation the app performs
// that a person did not directly cause." Everything else in this app is
// static by design; this one control is where all of that restraint gets
// spent.
struct CompletionControl: View {
    let isDone: Bool
    let taskTitle: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .strokeBorder(isDone ? Theme.live : Theme.muted, lineWidth: 1.5)
                Circle()
                    .fill(isDone ? Theme.live : Color.clear)
                if isDone {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.white)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .frame(width: 22, height: 22)
            .frame(width: Theme.completionControlSize, height: Theme.completionControlSize)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.2), value: isDone)
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
        .padding(.horizontal, Theme.Spacing.x4)
        .frame(minHeight: Theme.rowMinHeight)
    }
}

// DESIGN.md: "Primary button. Filled `live`, white text, radius 10, 50 tall,
// full width."
struct PrimaryButton: View {
    let title: String
    var isLoading: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if isLoading {
                    ProgressView().tint(.white)
                } else {
                    Text(title)
                        .font(Theme.Typography.body.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
        }
        .background(Theme.live)
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// DESIGN.md: "Destructive. Text only, `alert`. Never a filled red button —
// revoke is rare and should not look like the primary path."
struct DestructiveTextButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.alert)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
        }
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
