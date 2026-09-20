import SwiftUI

// mobile/FEATURES.md's Inbox tab: "Two kinds of thing need you, and they
// belong together" — approvals (queued agent actions) and clarifications
// (questions the agent has asked). Refetches whenever `model.inboxGeneration`
// bumps, which happens on every `pending-action` / `pending-action-resolved`
// / `clarification-created` SSE event, so this list is live rather than
// polled.
struct InboxView: View {
    @Environment(AppModel.self) private var model

    @State private var pendingActions: [PendingAction] = []
    @State private var clarifications: [Clarification] = []
    @State private var isLoading = false
    @State private var errorHeadline: String?

    var body: some View {
        NavigationStack {
            List {
                ScreenHeader(title: "Inbox", host: model.credentials.server.host ?? "",
                            ageMinutes: model.ageMinutes, refreshFailed: model.refreshFailed)

                if let errorHeadline {
                    Text(errorHeadline)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.alert)
                        .padding(.horizontal, Theme.gutter)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }

                if pendingActions.isEmpty && clarifications.isEmpty && !isLoading && errorHeadline == nil {
                    EmptyStateView(headline: "Nothing waiting on you.",
                                  detail: "Approvals and questions from OpenAGI appear here.")
                        .listRowInsets(EdgeInsets(top: 0, leading: Theme.gutter, bottom: 0, trailing: Theme.gutter))
                        .listRowBackground(Theme.canvas)
                        .listRowSeparator(.hidden)
                }

                if !pendingActions.isEmpty {
                    sectionHeader("Approvals")
                    RowGroup {
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

                if !clarifications.isEmpty {
                    sectionHeader("Clarifications")
                    RowGroup {
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

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let actions = model.client.pendingActions(status: "pending")
            async let clars = model.client.clarifications(status: "pending")
            let (a, c) = try await (actions, clars)
            pendingActions = a
            clarifications = c
            errorHeadline = nil
        } catch let error as DaemonError {
            errorHeadline = ApprovalError.message(for: error)
        } catch {
            errorHeadline = "Can't reach OpenAGI."
        }
        await model.refreshInboxCounts()
    }
}
