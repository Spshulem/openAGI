import SwiftUI

// mobile/FEATURES.md's Inbox tab: "Two kinds of thing need you, and they
// belong together" — approvals (queued agent actions) and clarifications
// (questions the agent has asked). Refetches whenever `model.inboxGeneration`
// bumps, which happens on every `pending-action` / `pending-action-resolved`
// / `clarification-created` SSE event, so this list is live rather than
// polled.
//
// DESIGN.md's "Screens must not be mostly empty" section: the two lists load
// independently (see `InboxLoader`), so a single endpoint failing (a 404 on
// `/tasks/clarifications` was a live daemon bug swallowed one section here
// used to blank the whole screen for) only ever removes its own section's
// content, never the other's.
struct InboxView: View {
    @Environment(AppModel.self) private var model

    @State private var pendingActions: [PendingAction] = []
    @State private var pendingActionsError: String?
    @State private var clarifications: [Clarification] = []
    @State private var clarificationsError: String?
    @State private var isLoading = false

    var body: some View {
        NavigationStack {
            List {
                ScreenHeader(title: "Inbox", host: model.credentials.server.host ?? "",
                            ageMinutes: model.ageMinutes, refreshFailed: model.refreshFailed)

                if isEverythingEmpty {
                    EmptyStateView(headline: "Nothing waiting on you.",
                                  detail: "Approvals and questions from OpenAGI appear here.")
                        .listRowInsets(EdgeInsets(top: 0, leading: Theme.gutter, bottom: 0, trailing: Theme.gutter))
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }

                if !pendingActions.isEmpty || pendingActionsError != nil {
                    sectionHeader("Approvals")
                    RowGroup {
                        if let pendingActionsError {
                            inlineErrorRow(pendingActionsError)
                        }
                        ForEach(Array(pendingActions.enumerated()), id: \.element.id) { index, action in
                            NavigationLink {
                                ApprovalDetailView(action: action, onDecided: { await load() })
                            } label: {
                                inboxRow(title: action.summary, secondary: action.toolName)
                            }
                            .buttonStyle(.plain)
                            if index < pendingActions.count - 1 { RowHairline() }
                        }
                    }
                    .padding(.horizontal, Theme.gutter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Theme.canvas)
                    .listRowSeparator(.hidden)
                }

                if !clarifications.isEmpty || clarificationsError != nil {
                    sectionHeader("Clarifications")
                    RowGroup {
                        if let clarificationsError {
                            inlineErrorRow(clarificationsError)
                        }
                        ForEach(Array(clarifications.enumerated()), id: \.element.id) { index, clarification in
                            NavigationLink {
                                ClarificationDetailView(clarification: clarification, onAnswered: { await load() })
                            } label: {
                                inboxRow(title: clarification.question, secondary: "About one of your tasks")
                            }
                            .buttonStyle(.plain)
                            if index < clarifications.count - 1 { RowHairline() }
                        }
                    }
                    .padding(.horizontal, Theme.gutter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Theme.canvas)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .refreshable { await load() }
            .task { await load() }
            .task(id: model.inboxGeneration) { await load() }
        }
    }

    private var isEverythingEmpty: Bool {
        pendingActions.isEmpty && clarifications.isEmpty
            && pendingActionsError == nil && clarificationsError == nil
            && !isLoading
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(Theme.Typography.section)
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, Theme.gutter)
            .padding(.top, Theme.Spacing.x4)
            .padding(.bottom, Theme.Spacing.x2)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Theme.canvas)
            .listRowSeparator(.hidden)
    }

    private func inboxRow(title: String, secondary: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1 / 2) {
            Text(title)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
            Text(secondary)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, Theme.Spacing.x4)
        .frame(minHeight: Theme.rowMinHeight, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    // The failure DESIGN.md calls for: "a single inline row in that
    // section, not an error that replaces the screen."
    private func inlineErrorRow(_ message: String) -> some View {
        Text(message)
            .font(Theme.Typography.secondary)
            .foregroundStyle(Theme.alert)
            .padding(.horizontal, Theme.Spacing.x4)
            .frame(minHeight: Theme.rowMinHeight, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        async let actionsResult: Result<[PendingAction], Error> = fetchResult { try await model.client.pendingActions(status: "pending") }
        async let clarificationsResult: Result<[Clarification], Error> = fetchResult { try await model.client.clarifications(status: "pending") }
        let combined = InboxLoader.combine(pendingActions: await actionsResult, clarifications: await clarificationsResult)
        pendingActions = combined.pendingActions
        pendingActionsError = combined.pendingActionsError
        clarifications = combined.clarifications
        clarificationsError = combined.clarificationsError
        await model.refreshInboxCounts()
    }

    private func fetchResult<T>(_ operation: () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await operation()) } catch { return .failure(error) }
    }
}
