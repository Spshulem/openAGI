import SwiftUI

struct InboxView: View {
    @Environment(AppModel.self) private var model
    @State private var fleetCards: [SupervisorCard] = []
    @State private var busyActionIDs: Set<String> = []
    @State private var actionBanner: String?
    private var pendingActions: [PendingAction] { model.workspace.pendingActions ?? [] }
    private var pendingActionsError: String? { model.pendingActionsError }
    private var clarifications: [Clarification] { model.workspace.clarifications ?? [] }
    private var clarificationsError: String? { model.clarificationsError }
    private var isLoading: Bool { model.isRefreshingInbox }
    private var hasLoaded: Bool { model.workspace.pendingActions != nil && model.workspace.clarifications != nil }

    var body: some View {
        NavigationStack {
            List {
                Section { AgentConnectionRow() }
                if let actionBanner {
                    Section {
                        Text(actionBanner)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Theme.live)
                    }
                }
                if !hasLoaded && isLoading {
                    ProgressView("Loading inbox…").frame(maxWidth: .infinity)
                }
                if !fleetCards.isEmpty {
                    Section("Coding Fleet · Needs You") {
                        ForEach(fleetCards) { card in
                            Button {
                                model.requestedFocusCardID = card.id
                                model.requestedChatThread = .supervisor
                                model.selectedTab = .chat
                            } label: {
                                inboxRow(
                                    title: card.headline,
                                    secondary: [card.project, card.kindLabel, card.prRef].compactMap { $0 }.joined(separator: " · ")
                                )
                            }
                            .accessibilityIdentifier("inbox-fleet-\(card.id)")
                        }
                    }
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
                            let ageMinutes = max(0, Int(Date().timeIntervalSince(action.lastRaisedAt) / 60))
                            let meta = [action.displaySubtitle, RelativeTime.compact(minutes: ageMinutes)]
                                .filter { !$0.isEmpty }
                                .joined(separator: " · ")
                            NavigationLink {
                                ApprovalDetailView(action: action, onDecided: { model.bumpInboxGeneration(); await load(force: true) })
                            } label: {
                                inboxRow(
                                    title: action.displayTitle,
                                    secondary: meta,
                                    busy: busyActionIDs.contains(action.id)
                                )
                            }
                            .accessibilityIdentifier("inbox-approval-\(action.id)")
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                if action.status == "pending" {
                                    Button("Approve", systemImage: "checkmark") {
                                        Task { await quickDecide(action, approve: true) }
                                    }
                                    .tint(Theme.live)
                                    .disabled(busyActionIDs.contains(action.id))
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if action.status == "pending" {
                                    Button("Deny", systemImage: "xmark", role: .destructive) {
                                        Task { await quickDecide(action, approve: false) }
                                    }
                                    .disabled(busyActionIDs.contains(action.id))
                                }
                            }
                        }
                    }
                }
                if !clarifications.isEmpty || clarificationsError != nil {
                    Section("Questions") {
                        if let clarificationsError { errorRow(clarificationsError) }
                        ForEach(clarifications) { clarification in
                            NavigationLink {
                                ClarificationDetailView(clarification: clarification, onAnswered: { model.bumpInboxGeneration(); await load(force: true) })
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
            .refreshable { await load(force: true) }
            .task(id: model.inboxGeneration) { await load() }
        }
    }

    private var isEverythingEmpty: Bool {
        fleetCards.isEmpty && pendingActions.isEmpty && clarifications.isEmpty
            && pendingActionsError == nil && clarificationsError == nil
            && hasLoaded && !isLoading
    }

    private func inboxRow(title: String, secondary: String, busy: Bool = false) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).foregroundStyle(.primary).lineLimit(2)
                Text(secondary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if busy {
                Spacer(minLength: 4)
                ProgressView()
            }
        }
    }

    private func quickDecide(_ action: PendingAction, approve: Bool) async {
        guard !busyActionIDs.contains(action.id) else { return }
        busyActionIDs.insert(action.id)
        defer { busyActionIDs.remove(action.id) }
        do {
            if approve {
                let res = try await model.client.approvePendingAction(id: action.id)
                actionBanner = res.ok ? "Approved: \(action.displayTitle)" : (res.error ?? "Approval could not run.")
            } else {
                _ = try await model.client.denyPendingAction(id: action.id, reason: nil)
                actionBanner = "Denied: \(action.displayTitle)"
            }
            model.bumpInboxGeneration()
            await load(force: true)
        } catch {
            actionBanner = "Couldn't reach OpenAGI to update that approval."
        }
    }

    private func errorRow(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
            Button("Retry") { Task { await load(force: true) } }
        }
    }

    private func load(force: Bool = false) async {
        await model.refreshInbox(force: force)
        if !model.isOnPhone && !ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            if let fleet = try? await model.client.fleetState() {
                fleetCards = SupervisorFormat.resolvedCards(fleet)
            }
        } else {
            fleetCards = []
        }
    }
}
