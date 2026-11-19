import SupervisorChannelsKit
import SwiftUI

struct ConversationBrowser: View {
    @Environment(AppModel.self) private var model
    @Binding var thread: ConversationThread
    var onSelect: (UUID?) -> Void
    @State private var search = ""
    @State private var showLegacyAgentChats = false

    private var isUITesting: Bool {
        ProcessInfo.processInfo.arguments.contains("--ui-testing")
    }

    private var showsWorkspaceChannels: Bool {
        !model.isOnPhone && !isUITesting
    }

    private var fleetCards: [SupervisorCard] {
        guard let state = model.latestFleetState else { return [] }
        return SupervisorFormat.resolvedCards(state)
    }

    private var fleetThreads: [FleetThread] {
        model.latestFleetState?.snapshot?.threads ?? []
    }

    private var decisionItems: [SupervisorDecisionItem] {
        fleetCards.map { card in
            SupervisorDecisionItem(
                id: card.id,
                project: SupervisorChannelGrouping.normalizeProject(explicit: card.project, repo: card.repo, workspace: card.workspace),
                subchannel: card.subchannel,
                headline: card.headline,
                kindLabel: card.kindLabel ?? "Needs you",
                risky: card.risky
            )
        }
    }

    private var sessionBriefs: [SupervisorSessionBrief] {
        fleetThreads.map { t in
            SupervisorSessionBrief(
                id: t.key,
                project: SupervisorChannelGrouping.normalizeProject(repo: t.repo, workspace: t.workspace),
                subchannel: t.subchannel,
                title: SupervisorFormat.name(t),
                state: t.state ?? "idle"
            )
        }
    }

    private var projectChannels: [SupervisorChannelSummary] {
        SupervisorChannelGrouping.projectChannels(from: decisionItems, sessions: sessionBriefs)
    }

    var body: some View {
        List {
            if let error = model.conversations.error {
                Section {
                    DisclosureGroup("Conversation list unavailable") {
                        Text(error).font(.footnote)
                    }
                    Button("Retry") { Task { await model.conversations.refresh() } }
                }
            }

            if showsWorkspaceChannels && search.isEmpty {
                workspaceChannelsSection
                if !projectChannels.isEmpty {
                    projectsSection
                }
            }

            if isUITesting || model.isOnPhone {
                ForEach(ConversationThread.allCases, id: \.self) { kind in
                    threadSection(kind: kind, headerTitle: kind == .agent ? "Agent" : "Supervisor")
                }
            } else {
                // Consolidated OpenAGI experience: Supervisor threads are primary;
                // legacy Agent threads stay accessible below without splitting the workspace.
                threadSection(kind: .supervisor, headerTitle: "Threads")
                let agentRecords = records(.agent).filter {
                    search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.preview.localizedCaseInsensitiveContains(search)
                }
                if !agentRecords.isEmpty {
                    Section {
                        DisclosureGroup("Direct agent chats (\(agentRecords.count))", isExpanded: $showLegacyAgentChats) {
                            ForEach(agentRecords, id: \.key) { record in
                                conversationRow(record: record, kind: .agent)
                            }
                        }
                        .font(.subheadline)
                    }
                }
            }

            if !search.isEmpty {
                Section("Messages in selected chat") {
                    ForEach(model.conversations.selected(thread).messages.filter { $0.text.localizedCaseInsensitiveContains(search) }) { message in
                        Button { onSelect(message.id) } label: {
                            Text(message.text).lineLimit(3).foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle(showsWorkspaceChannels ? "Workspace" : "Conversations")
        .searchable(text: $search, prompt: showsWorkspaceChannels ? "Search channels & threads" : "Search conversations")
        .refreshable { await model.conversations.refresh() }
        .task {
            await model.conversations.refresh()
            if showsWorkspaceChannels && model.latestFleetState == nil {
                if let fresh = try? await model.client.fleetState() {
                    model.latestFleetState = fresh
                }
            }
        }
        .accessibilityIdentifier("conversation-browser")
    }

    private var workspaceChannelsSection: some View {
        Section("Channels") {
            channelButton(.general, title: "#general", systemImage: "number", badge: nil)
            channelButton(
                .needsYou,
                title: "#needs-you",
                systemImage: "bell.badge",
                badge: fleetCards.isEmpty ? nil : "\(fleetCards.count)",
                badgeTint: Theme.caution
            )
            channelButton(.tasks, title: "#tasks", systemImage: "checklist", badge: nil)
            channelButton(
                .sessions,
                title: "#sessions",
                systemImage: "terminal",
                badge: fleetThreads.isEmpty ? nil : "\(fleetThreads.count)"
            )
            channelButton(
                .activity,
                title: "#activity",
                systemImage: "waveform.path.ecg",
                badge: (model.latestFleetState?.activityEvents.isEmpty ?? true) ? nil : "\(model.latestFleetState?.activityEvents.count ?? 0)"
            )
        }
    }

    private var projectsSection: some View {
        Section("Projects") {
            ForEach(projectChannels) { ch in
                let projName: String = {
                    if case let .project(name) = ch.kind { return name }
                    return ch.displayName
                }()
                channelButton(
                    .project(projName),
                    title: "#\(projName)",
                    systemImage: "folder",
                    badge: ch.waitingCount > 0 ? "\(ch.waitingCount)" : nil,
                    badgeTint: Theme.caution
                )
                let subs = SupervisorChannelGrouping.subchannels(
                    forProject: projName,
                    from: decisionItems,
                    sessions: sessionBriefs
                )
                ForEach(subs) { sub in
                    channelButton(
                        .subchannel(project: projName, subchannel: sub.displayName),
                        title: sub.displayName,
                        systemImage: "arrow.turn.down.right",
                        badge: sub.waitingCount > 0 ? "\(sub.waitingCount)" : nil,
                        badgeTint: Theme.caution,
                        indented: true
                    )
                }
            }
        }
    }

    private func channelButton(
        _ channel: iOSWorkspaceChannel,
        title: String,
        systemImage: String,
        badge: String? = nil,
        badgeTint: Color = Theme.muted,
        indented: Bool = false
    ) -> some View {
        let isSelected = thread == .supervisor && model.workspaceChannel == channel
        return Button {
            model.workspaceChannel = channel
            thread = .supervisor
            onSelect(nil)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(indented ? .caption2 : .subheadline)
                    .foregroundStyle(isSelected ? Theme.live : Theme.muted)
                    .frame(width: 18)
                Text(title)
                    .font(indented ? .footnote.weight(isSelected ? .semibold : .regular) : .subheadline.weight(isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? Theme.ink : .primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let badge {
                    Text(badge)
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(badgeTint.opacity(0.16), in: Capsule())
                        .foregroundStyle(badgeTint)
                }
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.live)
                }
            }
            .padding(.leading, indented ? 14 : 0)
            .padding(.vertical, 2)
        }
        .accessibilityIdentifier("workspace-channel-\(channel.title)")
    }

    private func threadSection(kind: ConversationThread, headerTitle: String) -> some View {
        Section {
            ForEach(records(kind).filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.preview.localizedCaseInsensitiveContains(search) }, id: \.key) { record in
                conversationRow(record: record, kind: kind)
            }
        } header: {
            HStack {
                Text(headerTitle)
                Spacer()
                Button("New chat", systemImage: "square.and.pencil") {
                    Task {
                        if await model.conversations.create(thread: kind) {
                            if kind == .supervisor {
                                model.workspaceChannel = .general
                            }
                            thread = kind
                            onSelect(nil)
                        }
                    }
                }
                .labelStyle(.iconOnly)
                .disabled(model.conversations.isCreating)
                .accessibilityIdentifier("new-\(kind.rawValue)-chat")
            }
        }
    }

    private func conversationRow(record: ConversationSummary, kind: ConversationThread) -> some View {
        Button {
            model.conversations.select(record)
            if kind == .supervisor {
                model.workspaceChannel = .general
            }
            thread = kind
            onSelect(nil)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: record.readOnly ? "globe" : kind == .agent ? "bubble.left.and.bubble.right" : "binoculars")
                VStack(alignment: .leading, spacing: 4) {
                    Text(record.title).lineLimit(1).foregroundStyle(.primary)
                    Text(record.preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    if record.readOnly { Text("Web chat").font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
                if thread == kind && model.conversations.selected(kind).conversationID == record.id && (!showsWorkspaceChannels || model.workspaceChannel == .general || kind == .agent) {
                    Image(systemName: "checkmark").accessibilityLabel("Selected")
                }
            }.padding(.vertical, 4)
        }
        .accessibilityIdentifier(record.id == "main" ? "conversation-\(kind.rawValue)" : "conversation-\(kind.rawValue)-\(record.id)")
    }

    private func records(_ kind: ConversationThread) -> [ConversationSummary] {
        let records = model.conversations.records(for: kind)
        if records.contains(where: { $0.id == "main" }) { return records }
        let chat = kind == .agent ? model.agentChat : model.supervisorChat
        return records + [ConversationSummary(id: "main", thread: kind, title: kind == .agent ? "Shared agent chat" : "OpenAGI Supervisor",
                                    preview: chat.messages.last?.text ?? "Start a conversation", updatedAt: .distantPast,
                                    messageCount: chat.messages.count, readOnly: false)]
    }
}
