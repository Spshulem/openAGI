import SwiftUI

struct InboxView: View {
    @Environment(AppModel.self) private var model
    @State private var pendingActions: [PendingAction] = []
    @State private var pendingActionsError: String?
    @State private var clarifications: [Clarification] = []
    @State private var clarificationsError: String?
    @State private var isLoading = false
    @State private var hasLoaded = false

    var body: some View {
        NavigationStack {
            List {
                Section { AgentConnectionRow() }
                if !hasLoaded && isLoading {
                    ProgressView("Loading inbox…").frame(maxWidth: .infinity)
                }
                if isEverythingEmpty {
                    ContentUnavailableView("Nothing waiting on you", systemImage: "tray",
                        description: Text("Approvals and questions from the connected agent appear here."))
                        .accessibilityIdentifier("inbox-empty")
                }
                if !pendingActions.isEmpty || pendingActionsError != nil {
                    Section("Approvals") {
                        if let pendingActionsError { errorRow(pendingActionsError) }
                        ForEach(pendingActions) { action in
                            NavigationLink {
                                ApprovalDetailView(action: action, onDecided: { await load() })
                            } label: {
                                inboxRow(title: action.summary, secondary: action.toolName)
                            }
                            .accessibilityIdentifier("inbox-approval-\(action.id)")
                        }
                    }
                }
                if !clarifications.isEmpty || clarificationsError != nil {
                    Section("Questions") {
                        if let clarificationsError { errorRow(clarificationsError) }
                        ForEach(clarifications) { clarification in
                            NavigationLink {
                                ClarificationDetailView(clarification: clarification, onAnswered: { await load() })
                            } label: {
                                inboxRow(title: clarification.question, secondary: "About one of your tasks")
                            }
                            .accessibilityIdentifier("inbox-question-\(clarification.id)")
                        }
                    }
                }
            }
            .navigationTitle("Inbox")
            .toolbar { WorkspaceChatToolbar() }
            .refreshable { await load() }
            .task(id: model.inboxGeneration) { await load() }
        }
    }

    private var isEverythingEmpty: Bool {
        pendingActions.isEmpty && clarifications.isEmpty
            && pendingActionsError == nil && clarificationsError == nil
            && hasLoaded && !isLoading
    }

    private func inboxRow(title: String, secondary: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).foregroundStyle(.primary)
            Text(secondary).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func errorRow(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            Button("Retry") { Task { await load() } }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        async let actionsResult: Result<[PendingAction], Error> = fetchResult { try await model.client.pendingActions(status: "pending") }
        async let clarificationsResult: Result<[Clarification], Error> = fetchResult { try await model.client.clarifications(status: "pending") }
        let combined = InboxLoader.combine(pendingActions: await actionsResult, clarifications: await clarificationsResult)
        guard !Task.isCancelled else { return }
        pendingActions = combined.pendingActions
        pendingActionsError = combined.pendingActionsError
        clarifications = combined.clarifications
        clarificationsError = combined.clarificationsError
        hasLoaded = true
        await model.refreshInboxCounts()
    }

    private func fetchResult<T: Sendable>(_ operation: () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await operation()) } catch { return .failure(error) }
    }
}
