import SwiftUI

// mobile/FEATURES.md's Today tab: today's tasks (matching the widget
// exactly), the brief headline above the list, pull to refresh, and "the
// day's shape in one sentence" below it.
struct TodayView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                ScreenHeader(title: "Today", host: model.credentials.server.host ?? "",
                            ageMinutes: model.ageMinutes, refreshFailed: model.refreshFailed)

                if let headline = model.snapshot?.summary.brief.headline, !headline.isEmpty {
                    Text(headline)
                        .font(Theme.Typography.section)
                        .foregroundStyle(Theme.ink)
                        .padding(.horizontal, Theme.gutter)
                        .padding(.bottom, Theme.Spacing.x2)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }

                let visible = model.snapshot?.visibleToday ?? []
                if visible.isEmpty {
                    EmptyStateView(headline: "Nothing left today.",
                                  detail: "New tasks appear here when OpenAGI or you add them.")
                        .listRowInsets(EdgeInsets(top: 0, leading: Theme.gutter, bottom: 0, trailing: Theme.gutter))
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                } else {
                    RowGroup {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { index, task in
                            TaskRow(title: task.title,
                                   secondaryText: task.overdue ? "Overdue" : nil,
                                   secondaryIsAlert: task.overdue,
                                   isBusy: model.isRefreshingToday) {
                                Task { await model.completeToday(taskID: task.id) }
                            }
                            if index < visible.count - 1 { RowHairline() }
                        }
                    }
                    .padding(.horizontal, Theme.gutter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Theme.canvas)
                    .listRowSeparator(.hidden)
                }

                if let counts = model.snapshot?.visibleCounts {
                    Text(dayShape(counts))
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, Theme.gutter)
                        .padding(.top, Theme.Spacing.x3)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .refreshable { await model.refreshToday() }
            .task { await model.refreshToday() }
        }
    }

    // DESIGN.md's mock: "2 left today, 1 this week".
    private func dayShape(_ counts: MobileSummary.Counts) -> String {
        var parts: [String] = []
        parts.append("\(counts.today) left today")
        if counts.thisWeek > 0 { parts.append("\(counts.thisWeek) this week") }
        return parts.joined(separator: ", ")
    }
}
