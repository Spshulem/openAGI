import PhotosUI
import SwiftUI
import SupervisorChannelsKit
import UIKit
import UniformTypeIdentifiers

fileprivate enum BoardBrowseMode: String, CaseIterable, Identifiable {
    case themes = "Projects"
    case sessions = "Sessions"
    case tasks = "Tasks"
    case activity = "Activity"
    var id: String { rawValue }
}

// mobile/FEATURES.md's Supervisor tab: one fluid conversation with the fleet
// supervisor ("supervisor" shared thread) paired with a pinned, swipeable
// Decision Card deck above the composer (Claude Duet style), a compact active
// sessions & BM25 search sheet in the toolbar, progressive non-auto-merge
// preferences, and a Scrutinizer autonomy banner with 1-tap veto.
struct SupervisorView: View {
    var showsInlineChat = true
    var navigationTitle: String = "Supervisor chat"
    var externalScrollToMessageID: UUID? = nil
    var onExternalScrollConsumed: () -> Void = {}
    var onOpenConversations: (() -> Void)? = nil
    var onOpenModel: (() -> Void)? = nil
    var onOpenSettings: (() -> Void)? = nil
    @Environment(AppModel.self) private var model

    @State private var state: FleetState?
    @State private var modelSettings: ModelSettings?
    @State private var isSwitchingModel = false
    @State private var loadError: DaemonError?
    @State private var lastLoadFailed = false
    @State private var scanning = false
    @State private var statusNote: SupervisorFormat.Note?
    @State private var modeBusy = false
    @State private var confirmAuto = false
    @State private var busyCardID: String?
    @State private var busyQuestionID: String?
    @State private var batchBusy = false
    @State private var questionNote: (id: String, note: SupervisorFormat.Note)?
    @State private var busyActionID: String?
    @State private var actionNote: (id: String, note: SupervisorFormat.Note)?
    @State private var actionNoteThread: String?
    @State private var selectedCardIndex = 0
    @State private var selectedProjectChannel: String? = nil
    @State private var selectedSubchannel: String? = nil
    @State private var activeLabelFilters: Set<String> = []
    @State private var initialBrowseMode: BoardBrowseMode = .themes
    @State private var clearedFocusCardID: String?
    @State private var selectedMessage: UUID?
    @State private var browserThread: ConversationThread = .supervisor

    private struct ThreadPresentation: Identifiable {
        let thread: FleetThread
        var question: FleetQuestion? = nil
        var card: SupervisorCard? = nil
        var id: String {
            thread.key + (question.map { "#\($0.id)" } ?? "") + (card.map { "@\($0.id)" } ?? "")
        }
    }

    private enum SupervisorSheet: String, Identifiable {
        case sessions, preferences, conversations
        var id: String { rawValue }
    }

    @State private var openThread: ThreadPresentation?
    @State private var activeSheet: SupervisorSheet?
    @State private var issued = 0
    @State private var applied = 0

    private var conversation: ChatConversation {
        model.conversations.selected(.supervisor)
    }

    private var cards: [SupervisorCard] {
        guard let state else { return [] }
        return SupervisorFormat.resolvedCards(state)
    }

    private var decisionItems: [SupervisorDecisionItem] {
        cards.map { card in
            SupervisorDecisionItem(
                id: card.id,
                project: SupervisorChannelGrouping.normalizeProject(
                    explicit: card.project,
                    repo: card.repo,
                    workspace: card.workspace
                ),
                subchannel: card.subchannel,
                headline: card.headline,
                kindLabel: card.kindLabel ?? "Needs you",
                risky: card.risky
            )
        }
    }

    private var sessionBriefs: [SupervisorSessionBrief] {
        (state?.snapshot?.threads ?? []).map { t in
            SupervisorSessionBrief(
                id: t.key,
                project: SupervisorChannelGrouping.normalizeProject(
                    repo: t.repo,
                    workspace: t.workspace
                ),
                subchannel: t.subchannel,
                title: SupervisorFormat.name(t),
                state: t.state ?? "idle"
            )
        }
    }

    private var channelSummaries: [SupervisorChannelSummary] {
        SupervisorChannelGrouping.projectChannels(from: decisionItems, sessions: sessionBriefs)
    }

    private var subchannelSummaries: [SupervisorSubchannelSummary] {
        guard let selectedProjectChannel else { return [] }
        return SupervisorChannelGrouping.subchannels(
            forProject: selectedProjectChannel,
            from: decisionItems,
            sessions: sessionBriefs
        )
    }

    private var availableLabels: [SupervisorBoardLabel] {
        Array(SupervisorBoardLabel.extract(from: cards.flatMap(\.labels)).prefix(10))
    }

    private func normalizedSubLeaf(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        let clean = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        let parts = clean.split(separator: "/").map(String.init)
        return parts.count > 1 ? parts.dropFirst().joined(separator: "/") : clean
    }

    private var displayedCards: [SupervisorCard] {
        cards.filter { card in
            if let selectedProjectChannel {
                let proj = SupervisorChannelGrouping.normalizeProject(
                    explicit: card.project,
                    repo: card.repo,
                    workspace: card.workspace
                )
                guard proj.caseInsensitiveCompare(selectedProjectChannel) == .orderedSame else {
                    return false
                }
            }
            if let selectedSubchannel, let targetSub = normalizedSubLeaf(selectedSubchannel) {
                guard let cardSub = normalizedSubLeaf(card.subchannel),
                      cardSub.caseInsensitiveCompare(targetSub) == .orderedSame else {
                    return false
                }
            }
            return SupervisorBoardLabel.matches(tags: card.labels, activeFilters: activeLabelFilters)
        }
    }

    private var clampedCardIndex: Int {
        guard !displayedCards.isEmpty else { return 0 }
        return min(max(0, selectedCardIndex), displayedCards.count - 1)
    }

    private var currentCard: SupervisorCard? {
        guard !displayedCards.isEmpty else { return nil }
        return displayedCards[clampedCardIndex]
    }

    var body: some View {
        // The supervisor watches coding agents, CI and builds on a Mac. The
        // agent on this iPhone has none of those to watch.
        if model.isOnPhone {
            NavigationStack {
                VStack(alignment: .leading, spacing: Theme.Spacing.x4) {
                    ScreenHeader(title: "Supervisor", host: model.hostLabel, ageMinutes: 0, refreshFailed: false)
                        .padding(.horizontal, -Theme.gutter)
                    Text("Supervisor watches the coding agents, pull requests and builds on your Mac.")
                        .font(Theme.Typography.body)
                        .foregroundStyle(Theme.ink)
                    Text("Connect a Mac in Settings to use it. Your agent on this iPhone keeps working either way.")
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.muted)
                    Spacer()
                }
                .padding(.horizontal, Theme.gutter)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.canvas)
            }
        } else {
            duetNavigation
        }
    }

    private var duetNavigation: some View {
        NavigationStack {
            ChatConversationView(
                conversation: conversation,
                title: navigationTitle,
                scrollToMessageID: selectedMessage ?? externalScrollToMessageID,
                placeholder: focusedPlaceholder,
                emptyDetail: "One project manager across your coding agents. Review decisions below, route a bug, or ask about any repo.",
                topAccessory: AnyView(topBannerStack),
                composerAccessory: { focused in AnyView(deckAccessory(composerFocused: focused)) },
                onHistorySelectionConsumed: {
                    selectedMessage = nil
                    onExternalScrollConsumed()
                }
            )
            .id(conversation.identity)
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    activeSessionsPill
                    Button("Conversations", systemImage: "text.bubble") {
                        if let onOpenConversations {
                            onOpenConversations()
                        } else {
                            browserThread = .supervisor
                            activeSheet = .conversations
                        }
                    }
                    .accessibilityIdentifier("chat-conversations")
                    if let onOpenModel {
                        Button("Model", systemImage: "cpu", action: onOpenModel)
                            .accessibilityIdentifier("chat-model")
                    }
                    overflowMenu
                }
            }
        }
        .task(id: model.fleetGeneration) { await refresh() }
        .onChange(of: model.requestedFocusCardID, initial: true) { _, cardID in
            applyRequestedFocus(cardID)
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(state?.running == true ? 5 : 25))
                if Task.isCancelled { break }
                await refresh()
            }
        }
        .onChange(of: cards.map(\.id)) { _, ids in
            if selectedCardIndex >= ids.count {
                selectedCardIndex = max(0, ids.count - 1)
            }
            syncFocusedCard()
        }
        .onChange(of: selectedCardIndex) { _, _ in
            clearedFocusCardID = nil
            syncFocusedCard()
        }
        .onChange(of: conversation.isSending) { _, sending in
            if !sending { Task { await refresh() } }
        }
        .sheet(item: $openThread) { opened in
            let thread = state?.snapshot?.threads.first(where: { $0.key == opened.thread.key }) ?? opened.thread
            let question = opened.question
                ?? opened.card?.questionId.flatMap { qid in state?.questions.first(where: { $0.id == qid }) }
                ?? state?.questions.first(where: {
                    $0.threadKey == thread.key || ($0.threadKeys ?? []).contains(thread.key)
                })
            let card = opened.card ?? cards.first(where: {
                $0.id == opened.card?.id
                    || ($0.questionId != nil && $0.questionId == question?.id)
                    || $0.threadKey == thread.key
                    || $0.threadKeys.contains(thread.key)
            })
            let isOpenQuestion = question.map { q in state?.questions.contains(where: { $0.id == q.id }) == true } ?? false
            let isOpenCard = card.map { c in cards.contains(where: { $0.id == c.id }) } ?? false
            ThreadDetailSheet(
                thread: thread,
                proposed: state?.mode == FleetMode.propose.rawValue
                    ? SupervisorFormat.proposed(for: thread, in: state?.actions ?? []) : [],
                busyActionID: busyActionID,
                actionNote: actionNoteThread == thread.key ? actionNote : nil,
                onSend: { action in Task { await send(action) } },
                question: question,
                questionIsOpen: isOpenQuestion || isOpenCard,
                questionBusy: busyQuestionID != nil || busyCardID != nil,
                questionNote: (question?.id ?? card?.questionId ?? card?.id).flatMap { id in questionNote?.id == id ? questionNote?.note : nil },
                onAnswer: { answer in
                    if let question {
                        Task { await decide(question, answer: answer) }
                    } else if let card {
                        Task { await act(card, action: SupervisorCardAction(op: "answer", label: answer, value: answer)) }
                    }
                },
                onDefer: {
                    if let card {
                        Task { await act(card, action: SupervisorCardAction(op: "defer", label: "Later")) }
                    } else if let question {
                        Task { await decide(question, answer: nil) }
                    }
                },
                card: card,
                onCardPrimary: { targetCard, action in
                    Task { await act(targetCard, action: action) }
                },
                onCardReply: { targetCard, text, attachments in
                    await act(targetCard, action: SupervisorCardAction(op: "reply", label: "Reply", value: text), images: attachments)
                }
            )
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .sessions:
                ActiveSessionsSheet(
                    state: state,
                    initialMode: initialBrowseMode,
                    scanning: scanning || state?.running == true,
                    onScan: { Task { await scan() } },
                    onAcceptState: { fresh in accept(nextSequence(), fresh) },
                    onSelectThread: { thread in
                        activeSheet = nil
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(200))
                            openThread = ThreadPresentation(thread: thread)
                            actionNote = nil
                        }
                    }
                )
            case .preferences:
                SupervisorPreferencesSheet(
                    preferences: state?.preferences ?? SupervisorPreferences(),
                    autonomy: state?.autonomy,
                    onUpdate: { cadence, mergePolicy, vetoSlice, vetoActionID in
                        await updatePreferences(cadence: cadence, mergePolicy: mergePolicy,
                                                vetoSlice: vetoSlice, vetoActionID: vetoActionID)
                    }
                )
            case .conversations:
                NavigationStack {
                    ConversationBrowser(thread: $browserThread) { message in
                        selectedMessage = message
                        activeSheet = nil
                        if browserThread == .agent {
                            model.selectedTab = .chat
                        }
                    }
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { activeSheet = nil } } }
                }
            }
        }
        .alert("Turn on Auto?", isPresented: $confirmAuto) {
            Button("Turn on Auto") { Task { await setMode(.auto) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("In Auto the supervisor sends preset nudges to your agents by itself, a few per scan, without asking first. Observe and Propose never send on their own.")
        }
    }

    private var focusedPlaceholder: String {
        if let card = currentCard, conversation.focusedCardID == card.id {
            return "Reply to decision or ask Supervisor…"
        }
        return "Ask Supervisor or route a bug…"
    }

    private func syncFocusedCard() {
        guard let card = currentCard else {
            conversation.focusedCardID = nil
            return
        }
        if clearedFocusCardID == card.id {
            conversation.focusedCardID = nil
        } else {
            conversation.focusedCardID = card.id
        }
    }

    // MARK: - Toolbar

    private var activeSessionsPill: some View {
        let label = state.map(SupervisorFormat.activePill) ?? (loadError != nil ? "Offline" : "Loading…")
        let isLive = (state?.running == true) || scanning || (state?.activeSummary?.running ?? 0) > 0
        return Button {
            initialBrowseMode = .sessions
            activeSheet = .sessions
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(lastLoadFailed ? Theme.alert : (isLive ? Color.green : Theme.muted))
                    .frame(width: 7, height: 7)
                Text(label)
                    .font(Theme.Typography.caption.weight(.medium))
                    .lineLimit(1)
            }
        }
        .accessibilityLabel("Active sessions: \(label)")
        .accessibilityIdentifier("supervisor-active-sessions-pill")
    }

    private var greenMergeableCount: Int {
        cards.filter { c in
            guard c.prRef != nil, c.kind == "merge_ready" || c.kind == "pr_ready" else { return false }
            guard c.primaryAction?.op == "merge", c.primaryAction?.label == "Merge PR" else { return false }
            let ci = (c.ciState ?? "").uppercased()
            if ["FAILURE", "ERROR", "PENDING", "IN_PROGRESS"].contains(ci) { return false }
            if (c.mergeState ?? "").uppercased() == "DIRTY" { return false }
            return true
        }.count
    }

    private var routineQuestionCount: Int {
        cards.filter { c in
            c.kind != "merge_ready" && c.kind != "pr_ready" && c.kind != "ci_failed"
        }.count
    }

    private var overflowMenu: some View {
        Menu {
            let isScanning = scanning || state?.running == true
            Button(isScanning ? "Scanning…" : "Scan now", systemImage: "arrow.clockwise") {
                Task { await scan() }
            }
            .disabled(isScanning)

            if greenMergeableCount > 0 {
                Button("Merge green PRs (\(greenMergeableCount))", systemImage: "arrow.triangle.merge") {
                    Task { await batchAct(op: "merge_green", filter: "green_prs") }
                }
                .disabled(batchBusy || busyCardID != nil)
            }

            if routineQuestionCount >= 2 {
                Button("Later all questions (\(routineQuestionCount))", systemImage: "clock") {
                    Task { await batchAct(op: "defer", filter: "questions") }
                }
                .disabled(batchBusy || busyCardID != nil)
            }

            Button("Active sessions & search", systemImage: "magnifyingglass") {
                initialBrowseMode = .themes
                activeSheet = .sessions
            }

            Button("Preferences", systemImage: "slider.horizontal.3") {
                activeSheet = .preferences
            }
            .accessibilityIdentifier("supervisor-preferences-button")

            if let state {
                Menu {
                    ForEach(FleetMode.allCases, id: \.self) { mode in
                        Button {
                            requestMode(mode)
                        } label: {
                            HStack {
                                Text(SupervisorFormat.modeLabel(mode))
                                if state.mode == mode.rawValue {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    Label("Mode: \(FleetMode(rawValue: state.mode ?? "").map(SupervisorFormat.modeLabel) ?? "Observe")",
                          systemImage: "gauge.with.dots.needle.33percent")
                }
                .disabled(modeBusy)
            }

            Divider()

            Button("Conversations", systemImage: "text.bubble") {
                if let onOpenConversations {
                    onOpenConversations()
                } else {
                    browserThread = .supervisor
                    activeSheet = .conversations
                }
            }
            .accessibilityIdentifier("supervisor-conversations")

            if let onOpenSettings {
                Button("Settings", systemImage: "gearshape", action: onOpenSettings)
            }
        } label: {
            Label("Supervisor options", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("supervisor-options-menu")
    }

    // MARK: - Top Banners (Warnings, Scrutinizer Autonomy & Catch-Up)

    @ViewBuilder
    private var topBannerStack: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let loadError, state == nil || SupervisorFormat.isUnavailable(loadError) {
                let copy = SupervisorFormat.errorCopy(loadError)
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.caution)
                        .font(.footnote)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(copy.headline).font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
                        Text(copy.detail).font(.caption).foregroundStyle(Theme.muted)
                    }
                    Spacer(minLength: 4)
                    Button("Retry") { Task { await refresh() } }
                        .font(.caption.weight(.semibold))
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 8)
                .background(Theme.surface)
            } else if let state {
                if let warning = SupervisorFormat.warning(state) {
                    Text(warning)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.alert)
                        .lineLimit(2)
                        .padding(.horizontal, Theme.gutter)
                        .padding(.top, 6)
                }
                if let autonomyLine = SupervisorFormat.autonomyLine(state.autonomy) {
                    autonomyBanner(line: autonomyLine, autonomy: state.autonomy)
                }
                if let catchUp = state.catchUpSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !catchUp.isEmpty, cards.count > 1 {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                            .foregroundStyle(Theme.live)
                        Text(catchUp)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                    }
                    .padding(.horizontal, Theme.gutter)
                    .padding(.vertical, 4)
                }
            }
            if let statusNote {
                HStack {
                    NoteLine(note: statusNote)
                    Spacer(minLength: 8)
                    Button {
                        self.statusNote = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption2)
                            .foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 4)
            }
            if state != nil || modelSettings != nil {
                VStack(alignment: .leading, spacing: 4) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            if let checkLabel = SupervisorQuietCheckFormatter.badge(nextCheckDate: state?.nextTickAt) {
                                BoardQuietCheckPill(label: checkLabel)
                            }

                            Button {
                                selectedProjectChannel = nil
                                selectedSubchannel = nil
                                selectedCardIndex = 0
                            } label: {
                                Text(cards.isEmpty ? "#general" : "#general · \(cards.count)")
                                    .font(Theme.Typography.caption.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(
                                        selectedProjectChannel == nil ? Theme.ink : Theme.surface,
                                        in: Capsule()
                                    )
                                    .foregroundStyle(selectedProjectChannel == nil ? Theme.canvas : Theme.ink)
                            }
                            .buttonStyle(.plain)

                            if let sessionsTotal = state?.activeSummary?.total ?? state?.snapshot?.threads.count, sessionsTotal > 0 {
                                Button {
                                    initialBrowseMode = .sessions
                                    activeSheet = .sessions
                                } label: {
                                    Text("#sessions · \(sessionsTotal)")
                                        .font(Theme.Typography.caption.weight(.semibold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(Theme.surface, in: Capsule())
                                        .foregroundStyle(Theme.ink)
                                }
                                .buttonStyle(.plain)
                            }

                            Button {
                                initialBrowseMode = .activity
                                activeSheet = .sessions
                            } label: {
                                let count = state?.activityEvents.count ?? 0
                                Text(count > 0 ? "#activity · \(count)" : "#activity")
                                    .font(Theme.Typography.caption.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(Theme.surface, in: Capsule())
                                    .foregroundStyle(Theme.ink)
                            }
                            .buttonStyle(.plain)

                            Button {
                                initialBrowseMode = .tasks
                                activeSheet = .sessions
                            } label: {
                                Label("Board", systemImage: "checklist")
                                    .font(Theme.Typography.caption.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(Theme.surface, in: Capsule())
                                    .foregroundStyle(Theme.ink)
                            }
                            .buttonStyle(.plain)

                            quickModelMenuPill

                            ForEach(channelSummaries) { ch in
                                let projName: String = {
                                    if case let .project(name) = ch.kind { return name }
                                    return ch.displayName
                                }()
                                let isSelected = selectedProjectChannel?.caseInsensitiveCompare(projName) == .orderedSame
                                Button {
                                    selectedProjectChannel = isSelected ? nil : projName
                                    selectedSubchannel = nil
                                    selectedCardIndex = 0
                                } label: {
                                    Text(ch.waitingCount > 0 ? "#\(projName) · \(ch.waitingCount)" : "#\(projName)")
                                        .font(Theme.Typography.caption.weight(.semibold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(isSelected ? Theme.ink : Theme.surface, in: Capsule())
                                        .foregroundStyle(isSelected ? Theme.canvas : Theme.ink)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, Theme.gutter)
                        .padding(.vertical, 6)
                    }
                    .accessibilityIdentifier("supervisor-project-channels")

                    if !subchannelSummaries.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(subchannelSummaries) { sub in
                                    let isSelected = selectedSubchannel?.caseInsensitiveCompare(sub.displayName) == .orderedSame
                                    Button {
                                        selectedSubchannel = isSelected ? nil : sub.displayName
                                        selectedCardIndex = 0
                                    } label: {
                                        Text(sub.waitingCount > 0 ? "\(sub.displayName) · \(sub.waitingCount)" : sub.displayName)
                                            .font(.caption2.weight(.semibold))
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 4)
                                            .background(isSelected ? Color.accentColor : Theme.surface, in: Capsule())
                                            .foregroundStyle(isSelected ? Color.white : Theme.ink)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, Theme.gutter)
                        }
                    }

                    if !availableLabels.isEmpty {
                        BoardLabelChipsRow(labels: availableLabels, activeFilters: $activeLabelFilters)
                            .padding(.horizontal, Theme.gutter)
                            .padding(.bottom, 4)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var quickModelMenuPill: some View {
        let activeLabel: String = {
            if isSwitchingModel { return "Switching…" }
            switch modelSettings?.active.provider {
            case "claude-cli": return "Claude CLI"
            case "codex-cli": return "Codex CLI"
            case "chatgpt": return "ChatGPT Plan"
            case "anthropic": return modelSettings?.active.model ?? "Claude"
            case "openai": return modelSettings?.active.model ?? "OpenAI"
            default: return modelSettings?.active.model ?? "Model"
            }
        }()
        Menu {
            if modelSettings?.providers.claudeCli?.available == true {
                Button {
                    Task { await selectModelPreference(preference: "claude-cli", claudeCliModel: "claude-sonnet-4-6") }
                } label: {
                    modelMenuRow("Claude Account (Pass-Through)", selected: modelSettings?.active.provider == "claude-cli")
                }
            }
            if modelSettings?.providers.codexCli?.available == true {
                Button {
                    Task { await selectModelPreference(preference: "codex-cli", codexCliModel: "gpt-5.4") }
                } label: {
                    modelMenuRow("Codex Account (Pass-Through)", selected: modelSettings?.active.provider == "codex-cli")
                }
            }
            if modelSettings?.providers.chatgpt?.signedIn == true {
                Button {
                    Task { await selectModelPreference(preference: "chatgpt") }
                } label: {
                    modelMenuRow("ChatGPT Plan", selected: modelSettings?.active.provider == "chatgpt")
                }
            }
            if modelSettings?.providers.openai.configured == true {
                Section("OpenAI API") {
                    ForEach(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-5.4"], id: \.self) { mId in
                        Button {
                            Task { await selectModelPreference(preference: "openai", openaiModel: mId) }
                        } label: {
                            modelMenuRow(mId, selected: modelSettings?.active.provider == "openai" && modelSettings?.active.model == mId)
                        }
                    }
                }
            }
            if modelSettings?.providers.anthropic.configured == true {
                Button {
                    Task { await selectModelPreference(preference: "anthropic", anthropicModel: "claude-sonnet-4-6") }
                } label: {
                    modelMenuRow("Claude API (Sonnet 4.6)", selected: modelSettings?.active.provider == "anthropic")
                }
            }
            if let onOpenModel {
                Divider()
                Button("Model & Keys Settings…", systemImage: "slider.horizontal.3", action: onOpenModel)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "sparkles")
                    .font(.caption2)
                Text(activeLabel)
                    .font(Theme.Typography.caption.weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.live.opacity(0.14), in: Capsule())
            .foregroundStyle(Theme.live)
        }
        .accessibilityIdentifier("supervisor-quick-model-pill")
    }

    @ViewBuilder
    private func modelMenuRow(_ label: String, selected: Bool) -> some View {
        if selected {
            Label(label, systemImage: "checkmark")
        } else {
            Text(label)
        }
    }

    private func autonomyBanner(line: String, autonomy: SupervisorAutonomy?) -> some View {
        let latestUnvetoed = autonomy?.recentActions.first(where: { !$0.vetoed })
        return HStack(spacing: 8) {
            Image(systemName: "bolt.fill")
                .font(.caption2)
                .foregroundStyle(Theme.live)
            Text(line)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let latest = latestUnvetoed {
                Button("Don't do that") {
                    Task {
                        await updatePreferences(cadence: nil, mergePolicy: nil,
                                                vetoSlice: latest.slice, vetoActionID: latest.id)
                    }
                }
                .font(Theme.Typography.caption.weight(.semibold))
                .foregroundStyle(Theme.alert)
                .buttonStyle(.plain)
                .accessibilityIdentifier("supervisor-autonomy-veto")
            }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, 6)
        .background(Theme.surface.opacity(0.85))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("supervisor-autonomy-banner")
    }

    // MARK: - Pinned Decision Card Deck Above Composer

    @ViewBuilder
    private func deckAccessory(composerFocused: Bool) -> some View {
        if let card = currentCard {
            if composerFocused {
                // Collapse deck into a sleek 1-line focus bar while typing so
                // history and composer stay comfortable above the keyboard.
                if conversation.focusedCardID == card.id {
                    HStack(spacing: 8) {
                        Image(systemName: "arrowshape.turn.up.left.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.live)
                        Text("Replying to: \(card.headline)")
                            .font(Theme.Typography.caption.weight(.medium))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Button {
                            clearedFocusCardID = card.id
                            conversation.focusedCardID = nil
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear card focus")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
            } else {
                SupervisorCardDeckView(
                    cards: displayedCards,
                    index: clampedCardIndex,
                    focusedCardID: conversation.focusedCardID,
                    busyCardID: busyCardID ?? busyQuestionID,
                    threads: state?.snapshot?.threads ?? [],
                    onSelectIndex: { newIndex in
                        selectedCardIndex = min(max(0, newIndex), max(0, displayedCards.count - 1))
                    },
                    onOpenContext: { target in openContext(for: target) },
                    onReplyInChat: { target in
                        clearedFocusCardID = nil
                        conversation.focusedCardID = target.id
                        conversation.requestComposerFocus()
                    },
                    onClearFocus: { target in
                        clearedFocusCardID = target.id
                        conversation.focusedCardID = nil
                    },
                    onAct: { target, action in
                        Task { await act(target, action: action) }
                    }
                )
                .padding(.horizontal, 12)
            }
        }
    }

    private func openContext(for card: SupervisorCard) {
        if card.kind == "preference" {
            activeSheet = .preferences
            return
        }
        let threads = state?.snapshot?.threads ?? []
        let key = card.threadKey ?? card.threadKeys.first
        let question = card.questionId.flatMap { qid in state?.questions.first(where: { $0.id == qid }) }
        let fallbackPR: FleetPR? = (card.prRef != nil || card.prUrl != nil || card.prContext != nil)
            ? FleetPR(
                ref: card.prContext?.ref ?? card.prRef,
                url: card.prContext?.url ?? card.prUrl,
                title: card.prContext?.title,
                bodySummary: card.prContext?.bodySummary,
                additions: card.prContext?.additions,
                deletions: card.prContext?.deletions,
                changedFiles: card.prContext?.changedFiles,
                files: card.prContext?.files ?? [],
                ci: (card.prContext?.ciState ?? card.ciState).map { FleetCI(state: $0) }
            )
            : nil
        if let key {
            let cleanSession = card.sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
            let thread = threads.first(where: { $0.key == key })
                ?? FleetThread(
                    key: key,
                    title: (cleanSession?.isEmpty == false ? cleanSession : nil) ?? card.headline,
                    workspace: SupervisorFormat.cleanWorkspace(card.workspace),
                    repo: card.repo,
                    branch: card.branch,
                    pr: fallbackPR,
                    lastAgentText: card.agentSummary
                )
            openThread = ThreadPresentation(thread: thread, question: question, card: card)
            actionNote = nil
        } else if let question {
            openThread = ThreadPresentation(
                thread: FleetThread(
                    key: "fleet:\(question.id)",
                    title: card.sessionTitle ?? card.headline,
                    pr: fallbackPR,
                    lastAgentText: card.agentSummary
                ),
                question: question,
                card: card
            )
            actionNote = nil
        }
    }

    // MARK: - Loading and Mutations

    private func accept(_ sequence: Int, _ fresh: FleetState) {
        guard sequence >= applied else { return }
        applied = sequence
        state = fresh
        loadError = nil
        lastLoadFailed = false
        syncFocusedCard()
        applyRequestedFocus(model.requestedFocusCardID)
    }

    private func applyRequestedFocus(_ cardID: String?) {
        guard let cardID, !cardID.isEmpty else { return }
        guard let idx = cards.firstIndex(where: { $0.id == cardID }) else { return }
        selectedProjectChannel = nil
        selectedCardIndex = idx
        clearedFocusCardID = nil
        conversation.focusedCardID = cards[idx].id
        model.requestedFocusCardID = nil
    }

    private func reject(_ sequence: Int, _ error: DaemonError) {
        guard sequence >= applied else { return }
        applied = sequence
        loadError = error
        lastLoadFailed = !SupervisorFormat.isUnavailable(error)
    }

    private func nextSequence() -> Int {
        issued += 1
        return issued
    }

    private func refresh() async {
        let sequence = nextSequence()
        async let freshModelSettings = try? model.client.modelSettings()
        do {
            let fresh = try await model.client.fleetState()
            accept(sequence, fresh)
        } catch let error as DaemonError {
            reject(sequence, error)
        } catch {
            reject(sequence, .transport(error))
        }
        if let updatedModels = await freshModelSettings {
            modelSettings = updatedModels
        }
    }

    private func selectModelPreference(
        preference: String,
        anthropicModel: String? = nil,
        openaiModel: String? = nil,
        claudeCliModel: String? = nil,
        codexCliModel: String? = nil
    ) async {
        guard !isSwitchingModel else { return }
        isSwitchingModel = true
        defer { isSwitchingModel = false }
        let update = ModelSettingsUpdate(
            preference: preference,
            anthropicModel: anthropicModel,
            openaiModel: openaiModel,
            claudeCliModel: claudeCliModel,
            codexCliModel: codexCliModel
        )
        do {
            modelSettings = try await model.client.updateModelSettings(update)
            statusNote = nil
        } catch let error as DaemonError {
            statusNote = SupervisorFormat.failureNote(error)
        } catch {
            statusNote = .init(text: "Couldn't switch models.", isAlert: true)
        }
    }

    private func scan() async {
        guard !scanning else { return }
        scanning = true
        statusNote = nil
        defer { scanning = false }
        do {
            let fresh = try await model.client.fleetScan()
            accept(nextSequence(), fresh)
        } catch let error as DaemonError {
            statusNote = SupervisorFormat.isTimeout(error)
                ? .init(text: "The scan is taking a while. It will update automatically when ready.", isAlert: false)
                : .init(text: SupervisorFormat.errorCopy(error).headline, isAlert: true)
            await refresh()
        } catch {
            await refresh()
        }
    }

    private func requestMode(_ mode: FleetMode) {
        guard !modeBusy, state?.mode != mode.rawValue else { return }
        if mode == .auto { confirmAuto = true } else { Task { await setMode(mode) } }
    }

    private func setMode(_ mode: FleetMode) async {
        guard !modeBusy, state?.mode != mode.rawValue else { return }
        modeBusy = true
        statusNote = nil
        defer { modeBusy = false }
        do {
            let fresh = try await model.client.fleetSetMode(mode)
            accept(nextSequence(), fresh)
        } catch let error as DaemonError {
            statusNote = .init(text: SupervisorFormat.errorCopy(error).headline, isAlert: true)
        } catch {
            statusNote = .init(text: "Can't reach OpenAGI.", isAlert: true)
        }
    }

    private func batchAct(op: String, filter: String? = nil) async {
        guard !batchBusy && busyCardID == nil else { return }
        batchBusy = true
        statusNote = nil
        defer { batchBusy = false }
        do {
            let res = try await model.client.fleetBatchCards(op: op, filter: filter)
            if let fresh = res.state {
                accept(nextSequence(), fresh)
            } else {
                await refresh()
            }
            let detail = res.result?.detail ?? "Batch action completed."
            statusNote = .init(text: detail, isAlert: res.result?.ok == false)
        } catch let error as DaemonError {
            statusNote = SupervisorFormat.failureNote(error)
        } catch {
            statusNote = .init(text: "Can't reach OpenAGI.", isAlert: true)
        }
    }

    @discardableResult
    private func act(_ card: SupervisorCard, action: SupervisorCardAction, images: [ChatAttachment] = []) async -> Bool {
        guard busyCardID == nil && busyQuestionID == nil else { return false }
        busyCardID = card.id
        statusNote = nil
        defer { busyCardID = nil }

        let noteTargetID = card.questionId ?? card.id
        let daemonHasCards = !(state?.cards.isEmpty ?? true)
        do {
            let result = try await model.client.fleetActCard(id: card.id, op: action.op, value: action.value, images: images)
            let note = SupervisorFormat.cardActNote(result)
            statusNote = note
            questionNote = (noteTargetID, note)
            if let fresh = result.state {
                accept(nextSequence(), fresh)
            } else {
                await refresh()
            }
            return !note.isAlert
        } catch DaemonError.notFound where !daemonHasCards && card.questionId != nil {
            // Older daemon fallback: translate card action to legacy /fleet/api/questions/:id.
            if let qid = card.questionId, let q = state?.questions.first(where: { $0.id == qid }) {
                busyCardID = nil
                if action.op == "defer" || action.op == "dismiss" {
                    return await decide(q, answer: nil)
                } else {
                    return await decide(q, answer: action.value ?? SupervisorFormat.answerOptions(q).first)
                }
            }
            return false
        } catch let error as DaemonError {
            let note = SupervisorFormat.failureNote(error)
            statusNote = note
            questionNote = (noteTargetID, note)
            if error == .conflict || error == .notFound { await refresh() }
            return false
        } catch {
            let note = SupervisorFormat.Note(text: "Can't reach OpenAGI.", isAlert: true)
            statusNote = note
            questionNote = (noteTargetID, note)
            return false
        }
    }

    // answer == nil is a dismissal.
    @discardableResult
    private func decide(_ question: FleetQuestion, answer: String?) async -> Bool {
        guard busyQuestionID == nil else { return false }
        busyQuestionID = question.id
        questionNote = nil
        defer { busyQuestionID = nil }
        do {
            let result: FleetMutationResult
            if let answer {
                result = try await model.client.fleetAnswer(questionID: question.id, answer: answer)
            } else {
                result = try await model.client.fleetDismiss(questionID: question.id)
            }
            let note = answer == nil
                ? SupervisorFormat.Note(text: "Saved for later.", isAlert: false)
                : SupervisorFormat.deliveryNote(result.delivery, fallback: "Answered.")
            questionNote = (question.id, note)
            statusNote = note
            if let fresh = result.state { accept(nextSequence(), fresh) } else { await refresh() }
            return !note.isAlert
        } catch let error as DaemonError {
            let note = SupervisorFormat.failureNote(error)
            questionNote = (question.id, note)
            statusNote = note
            if error == .conflict || error == .notFound { await refresh() }
            return false
        } catch {
            let note = SupervisorFormat.Note(text: "Can't reach OpenAGI.", isAlert: true)
            questionNote = (question.id, note)
            statusNote = note
            return false
        }
    }

    private func send(_ action: FleetAction) async {
        guard busyActionID == nil else { return }
        busyActionID = action.id
        actionNote = nil
        actionNoteThread = openThread?.thread.key
        defer { busyActionID = nil }
        do {
            let result = try await model.client.fleetSendAction(id: action.id)
            let note = SupervisorFormat.deliveryNote(result.delivery, fallback: "Sent.")
            actionNote = (action.id, note)
            statusNote = note
            if let fresh = result.state { accept(nextSequence(), fresh) } else { await refresh() }
        } catch let error as DaemonError {
            let note = SupervisorFormat.failureNote(error)
            actionNote = (action.id, note)
            if error == .conflict || error == .notFound { await refresh() }
        } catch {
            actionNote = (action.id, .init(text: "Can't reach OpenAGI.", isAlert: true))
        }
    }

    private func updatePreferences(cadence: String?, mergePolicy: String?, vetoSlice: String?, vetoActionID: String?) async {
        do {
            let fresh = try await model.client.fleetUpdatePreferences(
                cadence: cadence,
                mergePolicy: mergePolicy,
                vetoSlice: vetoSlice,
                vetoActionID: vetoActionID
            )
            accept(nextSequence(), fresh)
            statusNote = .init(text: vetoSlice != nil ? "Turned off automatic handling for that slice." : "Preferences updated.", isAlert: false)
        } catch let error as DaemonError {
            statusNote = SupervisorFormat.failureNote(error)
        } catch {
            statusNote = .init(text: "Can't reach OpenAGI.", isAlert: true)
        }
    }
}

// MARK: - Claude Duet Decision Card Deck

private struct SupervisorCardDeckView: View {
    let cards: [SupervisorCard]
    let index: Int
    let focusedCardID: String?
    let busyCardID: String?
    let threads: [FleetThread]
    let onSelectIndex: (Int) -> Void
    let onOpenContext: (SupervisorCard) -> Void
    let onReplyInChat: (SupervisorCard) -> Void
    let onClearFocus: (SupervisorCard) -> Void
    let onAct: (SupervisorCard, SupervisorCardAction) -> Void

    @State private var revealedPlanCardIDs: Set<String> = []

    private var card: SupervisorCard { cards[index] }
    private var isBusy: Bool { busyCardID != nil }
    private var hasThreadContext: Bool {
        card.threadKey != nil || !card.threadKeys.isEmpty
    }

    private var subtitleLine: String {
        let about: String?
        if card.threadKeys.count > 1 {
            about = "\(card.threadKeys.count) threads"
        } else if let ws = SupervisorFormat.cleanWorkspace(card.workspace) {
            about = ws
        } else if let repo = card.repo, !repo.isEmpty {
            about = repo
        } else if let key = card.threadKey, let thread = threads.first(where: { $0.key == key }) {
            about = SupervisorFormat.name(thread)
        } else {
            about = nil
        }
        let session: String? = {
            guard let raw = card.sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
            if card.headline.localizedCaseInsensitiveContains(raw) { return nil }
            if about?.caseInsensitiveCompare(raw) == .orderedSame { return nil }
            return raw
        }()
        let ci = card.ciState.flatMap { SupervisorFormat.ciLabel(FleetCI(state: $0)) }
        let pr = SupervisorFormat.prNumber(card.prRef)
        let diff = SupervisorFormat.diffStatLine(card.prContext)
        let ago = card.noticedAt.map { SupervisorFormat.agoPhrase($0) }
        return [about, session, pr, diff, ci, ago].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Deck header: kind badge + 1 of N stepper + focus chip
            HStack(spacing: 8) {
                let isFailureBadge = card.kind == "ci_failed" || ["FAILURE", "ERROR"].contains(card.ciState?.uppercased() ?? "")
                Text((card.kindLabel ?? "Needs you").uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(isFailureBadge ? Theme.alert : (card.risky ? Theme.caution : Theme.live))
                let projBadge = SupervisorChannelGrouping.normalizeProject(
                    explicit: card.project,
                    repo: card.repo,
                    workspace: card.workspace
                )
                if projBadge != "general" {
                    Text("#\(projBadge)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                }

                if cards.count > 1 {
                    Text("· \(index + 1) of \(cards.count)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                    Spacer(minLength: 4)
                    HStack(spacing: 4) {
                        Button {
                            onSelectIndex(index - 1)
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.caption.weight(.semibold))
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .disabled(index == 0)
                        .accessibilityLabel("Previous decision")

                        Button {
                            onSelectIndex(index + 1)
                        } label: {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .disabled(index >= cards.count - 1)
                        .accessibilityLabel("Next decision")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.ink)
                } else {
                    Spacer(minLength: 4)
                }

                if focusedCardID == card.id && card.kind != "preference" {
                    Button {
                        onClearFocus(card)
                    } label: {
                        HStack(spacing: 3) {
                            Text("Focused")
                            Image(systemName: "xmark")
                        }
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.canvas, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear focus from card")
                }
            }

            // Tappable card body -> opens Duet ThreadDetailSheet (read-only context)
            let contextID = "supervisor-question-context-\(card.questionId ?? card.id)"
            if hasThreadContext || card.kind == "preference" {
                Button {
                    onOpenContext(card)
                } label: {
                    cardSummaryContent(showsChevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(contextID)
                .accessibilityHint("Read the question and recent thread activity before answering")
            } else {
                cardSummaryContent(showsChevron: false)
                    .accessibilityIdentifier(contextID)
            }

            if card.canReply, !card.suggestedReplies.isEmpty, card.kind != "preference", card.kind != "merge_ready", card.kind != "pr_ready" {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(card.suggestedReplies.prefix(3).enumerated()), id: \.offset) { _, quickReply in
                            Button {
                                onAct(card, SupervisorCardAction(op: "reply", label: quickReply, value: quickReply))
                            } label: {
                                Text(quickReply)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.ink)
                                    .lineLimit(1)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Theme.canvas, in: Capsule())
                                    .overlay(Capsule().strokeBorder(Theme.edge.opacity(0.6), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .disabled(isBusy)
                        }
                    }
                }
            }

            // Action bar
            cardActions
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: 720, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(Theme.edge.opacity(0.6), lineWidth: 1)
        )
        .simultaneousGesture(
            DragGesture(minimumDistance: 28, coordinateSpace: .local)
                .onEnded { value in
                    guard cards.count > 1, abs(value.translation.width) > abs(value.translation.height) else { return }
                    if value.translation.width < -28, index < cards.count - 1 {
                        onSelectIndex(index + 1)
                    } else if value.translation.width > 28, index > 0 {
                        onSelectIndex(index - 1)
                    }
                }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("supervisor-card-deck")
    }

    private func cardSummaryContent(showsChevron: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(card.headline)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                if showsChevron {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                }
            }
            if !subtitleLine.isEmpty {
                Text(subtitleLine)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            if card.blockingCount > 0 {
                BoardBlockingPill(summary: card.blockingSummary ?? "Blocking \(card.blockingCount) downstream")
            }
            let subSlug = card.subchannel.flatMap { raw -> String? in
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return nil }
                let clean = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
                return clean.split(separator: "/").last.map(String.init) ?? clean
            }
            let cardLabels = Array(SupervisorBoardLabel.extract(from: card.labels).prefix(6))
            if card.actorLabel != nil || subSlug != nil || !cardLabels.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    if card.actorLabel != nil || subSlug != nil {
                        HStack(spacing: 6) {
                            if let actor = card.actorLabel, !actor.isEmpty {
                                BoardActorPill(actor: actor)
                            }
                            if let subSlug {
                                Text("/\(subSlug)")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 3)
                                    .background(Theme.surface, in: Capsule())
                                    .overlay(Capsule().strokeBorder(Theme.edge.opacity(0.6), lineWidth: 0.5))
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    if !cardLabels.isEmpty {
                        BoardReadOnlyLabelsRow(labels: cardLabels)
                    }
                }
            }
            if let ctx = card.brief?.context?.trimmingCharacters(in: .whitespacesAndNewlines), !ctx.isEmpty {
                Text(ctx)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            let mainSummary = (card.brief?.whatChanged?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                ?? (card.summary?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            if let summary = mainSummary {
                if summary.contains("\n") || summary.contains("|") {
                    MarkdownContent(blocks: MarkdownParser.parse(summary))
                        .lineLimit(nil)
                } else {
                    Text(MarkdownParser.inline(summary))
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.ink.opacity(0.92))
                        .lineLimit(5)
                        .multilineTextAlignment(.leading)
                }
            }
            if let decision = card.brief?.decision?.trimmingCharacters(in: .whitespacesAndNewlines),
               !decision.isEmpty,
               decision.caseInsensitiveCompare(card.headline) != .orderedSame {
                Text("Decision: \(decision)")
                    .font(Theme.Typography.caption.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            } else if let nextAction = card.plan?.nextAction?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !nextAction.isEmpty {
                Text("Question: \(nextAction)")
                    .font(Theme.Typography.caption.weight(.medium))
                    .foregroundStyle(Theme.live)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
            if revealedPlanCardIDs.contains(card.id), let plan = card.plan {
                VStack(alignment: .leading, spacing: 4) {
                    Text(plan.label ?? "Fix Plan")
                        .font(Theme.Typography.caption.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                    if let next = plan.nextAction?.trimmingCharacters(in: .whitespacesAndNewlines), !next.isEmpty {
                        Text(next)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.ink)
                    }
                    if let acc = plan.acceptance?.trimmingCharacters(in: .whitespacesAndNewlines), !acc.isEmpty {
                        Text("Acceptance: \(acc)")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.muted)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if let rec = card.recommendation?.trimmingCharacters(in: .whitespacesAndNewlines), !rec.isEmpty {
                Text(rec)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var cardActions: some View {
        let isExplicitActionCard = card.kind == "merge_ready" || card.kind == "pr_ready"
            || card.kind == "ci_failed" || card.kind == "preference"
            || card.primaryAction?.op == "merge" || card.primaryAction?.op == "fix_ci"
            || card.primaryAction?.op == "preference" || card.primaryAction?.op == "set_preference"

        HStack(spacing: 8) {
            if isExplicitActionCard, let primary = card.primaryAction, !primary.label.isEmpty {
                DeckPillButton(title: busyCardID == card.id ? "Working…" : primary.label, filled: true, enabled: !isBusy) {
                    onAct(card, primary)
                }
                .accessibilityIdentifier("supervisor-card-primary-\(card.id)")

                let extra = card.extraActions.first(where: { $0.op != "defer" && $0.op != "dismiss" && !$0.label.isEmpty })
                if let extra {
                    DeckPillButton(title: extra.label, filled: false, enabled: !isBusy) {
                        onAct(card, extra)
                    }
                    .accessibilityIdentifier("supervisor-card-extra-\(card.id)")
                }

                if card.kind != "preference" {
                    DeckPillButton(title: "Reply", filled: false, enabled: !isBusy) {
                        onReplyInChat(card)
                    }
                    .accessibilityIdentifier("supervisor-card-reply-\(card.id)")
                }

                Spacer(minLength: 0)

                let secondary = card.secondaryAction ?? SupervisorCardAction(op: "defer", label: "Later")
                Button(secondary.label) {
                    onAct(card, secondary)
                }
                .font(Theme.Typography.caption.weight(.medium))
                .foregroundStyle(Theme.muted)
                .frame(minHeight: 36)
                .padding(.horizontal, 6)
                .disabled(isBusy)
                .accessibilityIdentifier("supervisor-card-secondary-\(card.id)")
            } else if hasThreadContext {
                // Thread-backed agent decision: keep raw ambiguous "yes"/"no"
                // inside the Duet detail sheet after reading thread activity,
                // or let the owner reply naturally in the chat composer.
                DeckPillButton(title: "Review & decide", filled: true, enabled: !isBusy) {
                    onOpenContext(card)
                }
                .accessibilityIdentifier("supervisor-card-review-\(card.id)")

                DeckPillButton(title: "Reply in chat", filled: false, enabled: !isBusy) {
                    onReplyInChat(card)
                }
                .accessibilityIdentifier("supervisor-card-reply-\(card.id)")

                Spacer(minLength: 0)

                let secondary = card.secondaryAction ?? SupervisorCardAction(op: "defer", label: "Later")
                Button(secondary.label) {
                    onAct(card, secondary)
                }
                .font(Theme.Typography.caption.weight(.medium))
                .foregroundStyle(Theme.muted)
                .frame(minHeight: 36)
                .padding(.horizontal, 6)
                .disabled(isBusy)
                .accessibilityIdentifier("supervisor-card-secondary-\(card.id)")
            } else {
                // Fleet-wide question without a specific thread
                ForEach(Array(card.options.prefix(2).enumerated()), id: \.offset) { idx, option in
                    DeckPillButton(title: option, filled: idx == 0, enabled: !isBusy) {
                        if option == "Answer question" {
                            onReplyInChat(card)
                        } else if option == "Review plan", card.plan != nil {
                            if revealedPlanCardIDs.contains(card.id) {
                                revealedPlanCardIDs.remove(card.id)
                            } else {
                                revealedPlanCardIDs.insert(card.id)
                            }
                        } else {
                            onAct(card, SupervisorCardAction(op: "answer", label: option, value: option))
                        }
                    }
                }
                Spacer(minLength: 0)
                let secondary = card.secondaryAction ?? SupervisorCardAction(op: "defer", label: "Later")
                Button(secondary.label) {
                    onAct(card, secondary)
                }
                .font(Theme.Typography.caption.weight(.medium))
                .foregroundStyle(Theme.muted)
                .frame(minHeight: 36)
                .padding(.horizontal, 6)
                .disabled(isBusy)
            }
        }
    }
}

private struct DeckPillButton: View {
    let title: String
    let filled: Bool
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.caption.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(filled ? Color(uiColor: .systemBackground) : (enabled ? Theme.ink : Theme.muted))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minHeight: 36)
                .background {
                    Capsule()
                        .fill(filled ? Theme.ink.opacity(enabled ? 1 : 0.4) : Color.clear)
                }
                .overlay {
                    if !filled {
                        Capsule()
                            .strokeBorder(Theme.edge.opacity(enabled ? 0.8 : 0.3), lineWidth: 1)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

// MARK: - Active Sessions & BM25 Search Sheet

private struct ActiveSessionsSheet: View {
    let state: FleetState?
    var initialMode: BoardBrowseMode = .themes
    let scanning: Bool
    let onScan: () -> Void
    var onAcceptState: ((FleetState) -> Void)? = nil
    let onSelectThread: (FleetThread) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var browseMode: BoardBrowseMode
    @State private var query = ""
    @State private var searchHits: [FleetSearchHit] = []
    @State private var isSearching = false
    @State private var searchError: String?
    @State private var hierarchy: FleetHierarchyResponse?
    @State private var loadingHierarchy = false
    @State private var selectedProjectId: String?
    @State private var goalDraft = ""
    @State private var dispatchingGoal = false
    @State private var dispatchOutcomeNote: String?

    @State private var taskStateFilter: SupervisorBoardTaskState = .all
    @State private var taskLabelFilters: Set<String> = []
    @State private var newTaskTitle = ""
    @State private var creatingBoardTask = false
    @State private var claimingTaskID: String?
    @State private var boardTaskNote: String?
    @State private var inspectedThread: FleetThread?

    init(
        state: FleetState?,
        initialMode: BoardBrowseMode = .themes,
        scanning: Bool,
        onScan: @escaping () -> Void,
        onAcceptState: ((FleetState) -> Void)? = nil,
        onSelectThread: @escaping (FleetThread) -> Void
    ) {
        self.state = state
        self.initialMode = initialMode
        self.scanning = scanning
        self.onScan = onScan
        self.onAcceptState = onAcceptState
        self.onSelectThread = onSelectThread
        _browseMode = State(initialValue: initialMode)
    }

    private var threads: [FleetThread] {
        SupervisorFormat.sorted(state?.snapshot?.threads ?? [])
    }

    private var activeProject: FleetProjectGroup? {
        guard let selectedProjectId, let hierarchy else { return nil }
        return hierarchy.projects.first(where: { $0.id == selectedProjectId })
    }

    private var combinedBoardTasks: [TaskRecord] {
        let user = model.workspace.tasks[TaskQueue.user.rawValue] ?? []
        let agent = model.workspace.tasks[TaskQueue.agent.rawValue] ?? []
        return (user + agent).sorted { lhs, rhs in
            if lhs.queue != rhs.queue { return lhs.queue == TaskQueue.agent.rawValue }
            return lhs.priority > rhs.priority
        }
    }

    private var availableBoardTaskLabels: [SupervisorBoardLabel] {
        Array(SupervisorBoardLabel.extract(from: combinedBoardTasks.flatMap(\.tags)).prefix(12))
    }

    private var filteredBoardTasks: [TaskRecord] {
        combinedBoardTasks.filter { task in
            if let activeProject, let taskProj = task.sourceMeta?.project, !taskProj.isEmpty {
                guard taskProj.caseInsensitiveCompare(activeProject.name) == .orderedSame else {
                    return false
                }
            }
            let st = SupervisorBoardTaskClassifier.classify(
                status: task.status,
                queue: task.queue,
                hasUnmetDeps: !task.dependsOn.isEmpty && task.status.lowercased() == "blocked",
                leaseExpiresAtISO: task.sourceMeta?.agentLease?.expiresAt
            )
            if taskStateFilter != .all && st != taskStateFilter {
                return false
            }
            return SupervisorBoardLabel.matches(tags: task.tags, activeFilters: taskLabelFilters)
        }
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let isWide = geo.size.width >= 660
                Group {
                    if isWide {
                        HStack(spacing: 0) {
                            sessionsList(isWide: true)
                                .frame(width: min(390, max(300, geo.size.width * 0.43)))
                            Divider()
                            BoardThreadInspectorPane(
                                orderedThreads: threads,
                                selectedThread: $inspectedThread,
                                onExpand: onSelectThread,
                                onAcceptState: onAcceptState
                            )
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                        .onAppear {
                            if inspectedThread == nil, let first = threads.first {
                                inspectedThread = first
                            }
                        }
                    } else {
                        sessionsList(isWide: false)
                    }
                }
            }
            .searchable(text: $query, prompt: "Search repos, PRs, branches, transcripts")
            .task {
                await loadHierarchy()
            }
            .task(id: browseMode) {
                if browseMode == .tasks {
                    await refreshBoardTasks(force: true)
                }
            }
            .task(id: query) {
                let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    searchHits = []
                    searchError = nil
                    return
                }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                isSearching = true
                defer { isSearching = false }
                do {
                    let response = try await model.client.fleetSearch(query: trimmed, limit: 20)
                    searchHits = response.results
                    searchError = nil
                } catch DaemonError.notFound {
                    // Fallback to local thread filtering against an older daemon
                    searchHits = SupervisorFormat.fallbackSearchHits(threads, query: trimmed)
                    searchError = nil
                } catch {
                    searchError = "Couldn't search sessions right now."
                }
            }
            .navigationTitle(activeProject?.supervisorTitle ?? "Supervisor Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if activeProject != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("All Projects") {
                            selectedProjectId = nil
                            dispatchOutcomeNote = nil
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func resolveThread(
        key: String,
        title: String? = nil,
        workspace: String? = nil,
        repo: String? = nil,
        branch: String? = nil,
        state: String? = nil,
        health: String? = nil,
        prRef: String? = nil,
        live: Bool = false
    ) -> FleetThread {
        if let existing = threads.first(where: { $0.key == key }) {
            return existing
        }
        return FleetThread(
            key: key,
            title: title,
            workspace: workspace,
            repo: repo,
            branch: branch,
            state: state,
            health: health,
            pr: prRef.map { FleetPR(ref: $0) },
            live: live
        )
    }

    private func selectThread(_ thread: FleetThread, isWide: Bool) {
        if isWide {
            inspectedThread = thread
        } else {
            onSelectThread(thread)
        }
    }

    private func sessionsList(isWide: Bool) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    if let state {
                        HStack {
                            Text(SupervisorFormat.scanLine(lastTickAt: state.lastTickAt, autoScan: state.enabled, now: Date()))
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.muted)
                            Spacer()
                            Button(scanning ? "Scanning…" : "Scan now") { onScan() }
                                .font(Theme.Typography.caption.weight(.semibold))
                                .disabled(scanning)
                        }
                    }
                    Picker("Browse", selection: $browseMode) {
                        ForEach(BoardBrowseMode.allCases) { item in
                            Text(item.rawValue).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                }
            }

            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Section("Search across all sessions") {
                    if isSearching && searchHits.isEmpty {
                        ProgressView("Searching transcripts…")
                    } else if let searchError {
                        Text(searchError).font(.footnote).foregroundStyle(Theme.muted)
                    } else if searchHits.isEmpty {
                        Text("No matching sessions found.").font(.footnote).foregroundStyle(Theme.muted)
                    } else {
                        ForEach(searchHits) { hit in
                            Button {
                                let thread = resolveThread(
                                    key: hit.key,
                                    title: hit.title,
                                    workspace: hit.workspace,
                                    repo: hit.repo,
                                    branch: hit.branch,
                                    state: hit.state,
                                    health: hit.health,
                                    prRef: hit.prRef,
                                    live: hit.live
                                )
                                selectThread(thread, isWide: isWide)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    let hitTitle = SupervisorFormat.cleanWorkspace(hit.workspace)
                                        ?? hit.title.flatMap({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 })
                                        ?? SupervisorFormat.formatOpaqueKey(hit.key)
                                    Text(hitTitle)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Theme.ink)
                                    if let meta = [hit.repo, hit.branch, SupervisorFormat.prNumber(hit.prRef)].compactMap({ $0 }).joined(separator: " · ") as String?, !meta.isEmpty {
                                        Text(meta).font(.caption).foregroundStyle(Theme.muted)
                                    }
                                    if let snippet = hit.snippet, !snippet.isEmpty {
                                        Text(snippet)
                                            .font(.caption)
                                            .foregroundStyle(Theme.muted)
                                            .lineLimit(2)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            } else {
                switch browseMode {
                case .themes:
                    themesContent(isWide: isWide)
                case .sessions:
                    Section(threads.isEmpty ? "Sessions" : SupervisorFormat.summary(threads)) {
                        if state?.snapshot == nil {
                            Text("No scan yet. Tap Scan now.")
                                .font(.footnote)
                                .foregroundStyle(Theme.muted)
                        } else if threads.isEmpty {
                            Text("No recent coding threads.")
                                .font(.footnote)
                                .foregroundStyle(Theme.muted)
                        } else {
                            let proposing = state?.mode == FleetMode.propose.rawValue
                            ForEach(threads) { thread in
                                Button {
                                    selectThread(thread, isWide: isWide)
                                } label: {
                                    ThreadRow(
                                        thread: thread,
                                        hasProposal: proposing && !SupervisorFormat.proposed(for: thread, in: state?.actions ?? []).isEmpty
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                case .tasks:
                    boardTasksContent(isWide: isWide)
                case .activity:
                    boardActivityContent(isWide: isWide)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func themesContent(isWide: Bool) -> some View {
        if loadingHierarchy && hierarchy == nil {
            Section {
                ProgressView("Loading projects & themes…")
            }
        } else if let project = activeProject {
            Section("Direct \(project.supervisorTitle)") {
                TextField("e.g. Go work on the citation pipeline…", text: $goalDraft, axis: .vertical)
                    .lineLimit(2...4)
                HStack(spacing: 10) {
                    Button(dispatchingGoal ? "Routing…" : "Auto-Route & Work") {
                        Task { await runGoalDispatch(project: project.name, mode: "auto") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(dispatchingGoal || goalDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button("Preview") {
                        Task { await runGoalDispatch(project: project.name, mode: "preview") }
                    }
                    .buttonStyle(.bordered)
                    .disabled(dispatchingGoal || goalDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let dispatchOutcomeNote {
                    Text(dispatchOutcomeNote)
                        .font(.caption)
                        .foregroundStyle(Theme.ink)
                }
            }

            ForEach(project.themes) { theme in
                Section("\(theme.name) (\(theme.counts.total))") {
                    ForEach(theme.sessions) { item in
                        Button {
                            let mapped = resolveThread(
                                key: item.key,
                                title: item.title,
                                workspace: project.name,
                                repo: project.repo,
                                state: item.state,
                                prRef: item.prRefs.first,
                                live: item.state == "running"
                            )
                            selectThread(mapped, isWide: isWide)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                let nonEmptyTitle = item.title.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
                                HStack {
                                    Text(nonEmptyTitle ?? SupervisorFormat.formatOpaqueKey(item.key))
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Theme.ink)
                                    Spacer()
                                    Text((item.state ?? "idle").capitalized)
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(item.state == "running" ? Theme.live : Theme.muted)
                                }
                                let sub = [item.host, item.prRefs.first.flatMap(SupervisorFormat.prNumber)].compactMap { $0 }.joined(separator: " · ")
                                if !sub.isEmpty {
                                    Text(sub).font(.caption).foregroundStyle(Theme.muted)
                                }
                                if let snippet = item.snippet, !snippet.isEmpty {
                                    Text(snippet).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        } else if let hierarchy, !hierarchy.projects.isEmpty {
            Section("Active Projects (\(hierarchy.projects.count))") {
                ForEach(hierarchy.projects) { project in
                    Button {
                        selectedProjectId = project.id
                        dispatchOutcomeNote = nil
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(project.supervisorTitle)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.ink)
                                Spacer()
                                if project.counts.running > 0 {
                                    Text("\(project.counts.running) active")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(Theme.live)
                                } else {
                                    Text("\(project.counts.total) chats")
                                        .font(.caption2)
                                        .foregroundStyle(Theme.muted)
                                }
                            }
                            if !project.themes.isEmpty {
                                Text(project.themes.prefix(3).map(\.name).joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(Theme.muted)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                }
            }
        } else {
            Section("Projects & Themes") {
                Text("Switch to Sessions or tap Scan now to populate project themes.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
        }
    }

    @ViewBuilder
    private func boardTasksContent(isWide: Bool) -> some View {
        Section("Start Task in Paseo") {
            HStack(spacing: 8) {
                TextField("New task title — start coding session…", text: $newTaskTitle)
                Button(creatingBoardTask ? "Starting…" : "Start") {
                    Task { await startNewBoardTask(isWide: isWide) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(creatingBoardTask || newTaskTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(SupervisorBoardTaskState.allCases) { item in
                        let selected = taskStateFilter == item
                        Button {
                            taskStateFilter = item
                        } label: {
                            Label(item.label, systemImage: item.systemImage)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 5)
                                .background(selected ? Theme.live : Theme.surface, in: Capsule())
                                .foregroundStyle(selected ? Color.white : Theme.ink)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if !availableBoardTaskLabels.isEmpty {
                BoardLabelChipsRow(labels: availableBoardTaskLabels, activeFilters: $taskLabelFilters)
            }

            if let boardTaskNote {
                Text(boardTaskNote)
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
        }

        Section("Board Tasks (\(filteredBoardTasks.count))") {
            if filteredBoardTasks.isEmpty {
                Text("No tasks match the current Board filter.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            } else {
                ForEach(filteredBoardTasks) { task in
                    let taskState = SupervisorBoardTaskClassifier.classify(
                        status: task.status,
                        queue: task.queue,
                        hasUnmetDeps: !task.dependsOn.isEmpty && task.status.lowercased() == "blocked",
                        leaseExpiresAtISO: task.sourceMeta?.agentLease?.expiresAt
                    )
                    let leaseBadge = SupervisorBoardTaskClassifier.leaseBadgeText(expiresAtISO: task.sourceMeta?.agentLease?.expiresAt)
                    let rowLabels = SupervisorBoardLabel.extract(from: task.tags)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(task.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                            Spacer()
                            Text(leaseBadge ?? taskState.label)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Theme.live.opacity(0.12), in: Capsule())
                                .foregroundStyle(taskState == .blocked ? Theme.alert : Theme.live)
                        }

                        if let blockedReason = task.sourceMeta?.blockedReason, !blockedReason.isEmpty {
                            BoardBlockingPill(summary: blockedReason)
                        }

                        HStack(spacing: 6) {
                            if let actor = task.sourceMeta?.actor, !actor.isEmpty {
                                BoardActorPill(actor: actor)
                            }
                            if let project = task.sourceMeta?.project, !project.isEmpty {
                                let sub = task.sourceMeta?.subchannel.flatMap { $0.isEmpty ? nil : "/\($0)" } ?? ""
                                Text("#\(project)\(sub)")
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(Theme.muted)
                            }
                        }

                        if !rowLabels.isEmpty {
                            BoardReadOnlyLabelsRow(labels: rowLabels)
                        }

                        HStack(spacing: 8) {
                            if let threadKey = task.sourceMeta?.threadKey, !threadKey.isEmpty {
                                Button("Inspect session") {
                                    let resolved = resolveThread(
                                        key: threadKey,
                                        title: task.title,
                                        workspace: task.sourceMeta?.project
                                    )
                                    selectThread(resolved, isWide: isWide)
                                }
                                .buttonStyle(.bordered)
                                .font(.caption.weight(.semibold))
                            } else if !["completed", "cancelled"].contains(task.status.lowercased()) {
                                Button(claimingTaskID == task.id ? "Claiming…" : "Claim in Paseo") {
                                    Task { await claimExistingTask(task, isWide: isWide) }
                                }
                                .buttonStyle(.borderedProminent)
                                .font(.caption.weight(.semibold))
                                .disabled(claimingTaskID != nil)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    @ViewBuilder
    private func boardActivityContent(isWide: Bool) -> some View {
        let events = state?.activityEvents ?? []
        Section("Recent Activity (\(events.count))") {
            if events.isEmpty {
                Text("No recent board activity recorded yet.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            } else {
                ForEach(events) { event in
                    let rowLabels = SupervisorBoardLabel.extract(from: event.labels)
                    let content = VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(event.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                                .lineLimit(2)
                            Spacer()
                            if let at = event.at {
                                Text(SupervisorFormat.clockTime(at))
                                    .font(.caption2)
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                        if let detail = event.detail, !detail.isEmpty {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(2)
                        }
                        HStack(spacing: 6) {
                            if let actor = event.actor, !actor.isEmpty {
                                BoardActorPill(actor: actor)
                            }
                            if let proj = event.project, !proj.isEmpty {
                                let sub = event.subchannel.flatMap { $0.isEmpty ? nil : "/\($0)" } ?? ""
                                Text("#\(proj)\(sub)")
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(Theme.muted)
                            }
                            if let pr = SupervisorFormat.prNumber(event.prRef) {
                                Text(pr)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                        if !rowLabels.isEmpty {
                            BoardReadOnlyLabelsRow(labels: rowLabels)
                        }
                    }
                    .padding(.vertical, 3)

                    if let threadKey = event.threadKey, !threadKey.isEmpty {
                        Button {
                            let resolved = resolveThread(
                                key: threadKey,
                                title: event.title,
                                workspace: event.project,
                                prRef: event.prRef
                            )
                            selectThread(resolved, isWide: isWide)
                        } label: {
                            content
                        }
                        .buttonStyle(.plain)
                    } else {
                        content
                    }
                }
            }
        }
    }

    private func refreshBoardTasks(force: Bool) async {
        async let userRefresh: Void = model.refreshTasks(queue: .user, force: force)
        async let agentRefresh: Void = model.refreshTasks(queue: .agent, force: force)
        _ = await (userRefresh, agentRefresh)
    }

    private func startNewBoardTask(isWide: Bool) async {
        let trimmed = newTaskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !creatingBoardTask else { return }
        creatingBoardTask = true
        boardTaskNote = nil
        defer { creatingBoardTask = false }
        do {
            let res = try await model.client.fleetClaimTask(
                title: trimmed,
                workspace: activeProject?.name,
                project: activeProject?.name
            )
            newTaskTitle = ""
            if let fresh = res.state {
                onAcceptState?(fresh)
            }
            await refreshBoardTasks(force: true)
            if let session = res.session, !session.key.isEmpty {
                let target = resolveThread(
                    key: session.key,
                    title: session.title ?? trimmed,
                    workspace: session.workspace ?? activeProject?.name,
                    state: "running",
                    live: true
                )
                selectThread(target, isWide: isWide)
            } else {
                boardTaskNote = "Task created."
            }
        } catch {
            boardTaskNote = "Could not start task right now."
        }
    }

    private func claimExistingTask(_ task: TaskRecord, isWide: Bool) async {
        guard claimingTaskID == nil else { return }
        claimingTaskID = task.id
        boardTaskNote = nil
        defer { claimingTaskID = nil }
        do {
            let res = try await model.claimTaskInPaseo(task, workspace: activeProject?.name)
            if let fresh = res.state {
                onAcceptState?(fresh)
            }
            await refreshBoardTasks(force: true)
            if let session = res.session, !session.key.isEmpty {
                let target = resolveThread(
                    key: session.key,
                    title: session.title ?? task.title,
                    workspace: session.workspace ?? task.sourceMeta?.project ?? activeProject?.name,
                    state: "running",
                    live: true
                )
                selectThread(target, isWide: isWide)
            }
        } catch {
            boardTaskNote = "Could not claim task in Paseo."
        }
    }

    private func loadHierarchy() async {
        guard !loadingHierarchy else { return }
        loadingHierarchy = true
        defer { loadingHierarchy = false }
        do {
            let loaded = try await model.client.fleetHierarchy(limit: 40)
            hierarchy = loaded
            if loaded.projects.isEmpty && browseMode == .themes {
                browseMode = .sessions
            }
        } catch {
            if hierarchy == nil && browseMode == .themes {
                browseMode = .sessions
            }
        }
    }

    private func runGoalDispatch(project: String, mode: String) async {
        let trimmed = goalDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !dispatchingGoal else { return }
        dispatchingGoal = true
        defer { dispatchingGoal = false }
        do {
            let res = try await model.client.fleetDispatchGoal(project: project, goal: trimmed, mode: mode)
            if let fresh = res.state {
                onAcceptState?(fresh)
            }
            if let outcome = res.result {
                switch outcome.status {
                case "suggest_existing":
                    let title = outcome.matchedSession?.title ?? outcome.matchedSession?.key ?? "existing chat"
                    dispatchOutcomeNote = "Match found: \"\(title)\". Tap Auto-Route & Work to send to it."
                case "suggest_new":
                    dispatchOutcomeNote = "No existing chat owns this workstream — Auto-Route & Work will start a new Paseo session in \(project)."
                case "routed_existing":
                    let title = outcome.matchedSession?.title ?? outcome.matchedSession?.key ?? "existing chat"
                    dispatchOutcomeNote = "Routed directive to \"\(title)\"."
                    goalDraft = ""
                    await loadHierarchy()
                case "started_new":
                    let title = outcome.createdSession?.title ?? "new session"
                    dispatchOutcomeNote = "Started new Paseo session \"\(title)\" in \(project)."
                    goalDraft = ""
                    await loadHierarchy()
                case "blocked":
                    dispatchOutcomeNote = outcome.message ?? "Supervisor could not deliver directive right now."
                default:
                    dispatchOutcomeNote = outcome.message ?? "Supervisor status: \(outcome.status)."
                }
            }
        } catch {
            dispatchOutcomeNote = "Could not dispatch directive right now."
        }
    }
}

private struct BoardThreadInspectorPane: View {
    @Environment(AppModel.self) private var model
    let orderedThreads: [FleetThread]
    @Binding var selectedThread: FleetThread?
    let onExpand: (FleetThread) -> Void
    var onAcceptState: ((FleetState) -> Void)? = nil

    @State private var replyDraft = ""
    @State private var sendingReply = false
    @State private var replyStatus: String?

    private var activeIndex: Int? {
        guard let selectedThread else { return nil }
        return orderedThreads.firstIndex(where: { $0.key == selectedThread.key })
    }

    var body: some View {
        if let thread = selectedThread {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(SupervisorFormat.name(thread))
                            .font(.headline)
                            .lineLimit(1)
                        Spacer()
                        if orderedThreads.count > 1, let idx = activeIndex {
                            Text("\(idx + 1)/\(orderedThreads.count)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(Theme.muted)
                            Button {
                                step(-1, from: idx)
                            } label: {
                                Image(systemName: "chevron.up")
                            }
                            .disabled(idx <= 0)
                            Button {
                                step(1, from: idx)
                            } label: {
                                Image(systemName: "chevron.down")
                            }
                            .disabled(idx >= orderedThreads.count - 1)
                        }
                        Button {
                            onExpand(thread)
                        } label: {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                        }
                        .accessibilityLabel("Expand thread")
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            HealthAndState(thread: thread, font: Theme.Typography.caption)
                            if let actor = thread.actorLabel, !actor.isEmpty {
                                BoardActorPill(actor: actor)
                            }
                            if let check = SupervisorQuietCheckFormatter.badge(nextCheckDate: thread.nextCheckAt) {
                                BoardQuietCheckPill(label: check)
                            }
                            if let prChip = SupervisorFormat.prChip(thread.pr) {
                                Chip(text: prChip, color: SupervisorFormat.ciFailing(thread.pr?.ci) ? Theme.alert : Theme.ink)
                            }
                        }
                    }

                    if let line = thread.reason.flatMap({ $0.isEmpty ? nil : $0 }) ?? thread.blockers.first {
                        Text(line)
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Theme.surface)

                Divider()

                FleetConversationView(thread: thread, fallbackSummary: thread.lastAgentText)
                    .padding(.horizontal, 16)
                    .id(thread.key)

                Divider()

                VStack(alignment: .leading, spacing: 6) {
                    if let replyStatus {
                        Text(replyStatus)
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                    }
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("Send follow-up to \(SupervisorFormat.name(thread))…", text: $replyDraft, axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.roundedBorder)
                        Button {
                            Task { await sendReply(to: thread) }
                        } label: {
                            Image(systemName: sendingReply ? "hourglass" : "arrow.up.circle.fill")
                                .font(.title2)
                        }
                        .disabled(sendingReply || replyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(12)
                .background(Theme.surface)
            }
        } else {
            ContentUnavailableView(
                "Select a Thread",
                systemImage: "sidebar.right",
                description: Text("Pick a session, task, or activity item on the left to inspect its live conversation.")
            )
        }
    }

    private func step(_ delta: Int, from idx: Int) {
        let next = idx + delta
        guard orderedThreads.indices.contains(next) else { return }
        selectedThread = orderedThreads[next]
        replyStatus = nil
    }

    private func sendReply(to thread: FleetThread) async {
        let trimmed = replyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sendingReply else { return }
        sendingReply = true
        replyStatus = nil
        defer { sendingReply = false }
        do {
            let res = try await model.client.fleetSendMessage(threadKey: thread.key, message: trimmed)
            replyDraft = ""
            if let fresh = res.state {
                onAcceptState?(fresh)
            }
            replyStatus = res.delivery?.detail ?? res.delivery?.status ?? "Delivered to session."
        } catch {
            replyStatus = "Couldn't send right now."
        }
    }
}

// MARK: - Progressive Preferences Sheet

private struct SupervisorPreferencesSheet: View {
    let preferences: SupervisorPreferences
    let autonomy: SupervisorAutonomy?
    let onUpdate: (String?, String?, String?, String?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var cadence: String
    @State private var mergePolicy: String
    @State private var saving = false

    init(preferences: SupervisorPreferences, autonomy: SupervisorAutonomy?,
         onUpdate: @escaping (String?, String?, String?, String?) async -> Void) {
        self.preferences = preferences
        self.autonomy = autonomy
        self.onUpdate = onUpdate
        _cadence = State(initialValue: preferences.cadence)
        _mergePolicy = State(initialValue: preferences.mergePolicy)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Update cadence", selection: $cadence) {
                        Text("Quiet until ready").tag("quiet_until_ready")
                        Text("Balanced (Default)").tag("balanced")
                        Text("Detailed updates").tag("detailed")
                    }
                    .disabled(saving)
                    .onChange(of: cadence) { _, next in
                        guard next != preferences.cadence else { return }
                        Task {
                            saving = true
                            await onUpdate(next, nil, nil, nil)
                            saving = false
                        }
                    }
                } header: {
                    Text("Notifications & Cadence")
                } footer: {
                    Text("Supervisor starts balanced out of the box and suggests quieter or automatic handling progressively as it learns your habits.")
                }

                Section {
                    Picker("When you tap Merge PR", selection: $mergePolicy) {
                        Text("Confirm only when CI is green (Default)").tag("manual_confirm")
                        Text("Queue merge when CI passes").tag("queue_when_green")
                    }
                    .disabled(saving)
                    .onChange(of: mergePolicy) { _, next in
                        guard next != preferences.mergePolicy else { return }
                        Task {
                            saving = true
                            await onUpdate(nil, next, nil, nil)
                            saving = false
                        }
                    }
                } header: {
                    Text("Pull Request Safety")
                } footer: {
                    Text("Supervisor never merges pull requests unprompted. By default, tapping Merge PR while CI is still running watches CI and pings you when checks are green instead of queueing auto-merge.")
                }

                Section("Learned Routine Slices") {
                    if preferences.autoSlices.isEmpty {
                        Text("No slices automated yet. After repeated identical approvals, Supervisor will ask if you want to make a routine slice automatic.")
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                    } else {
                        ForEach(preferences.autoSlices, id: \.self) { slice in
                            HStack {
                                Text(slice.replacingOccurrences(of: "_", with: " ").capitalized)
                                Spacer()
                                Button("Turn off", role: .destructive) {
                                    Task {
                                        saving = true
                                        await onUpdate(nil, nil, slice, nil)
                                        saving = false
                                    }
                                }
                                .font(.footnote.weight(.semibold))
                                .disabled(saving)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Preferences")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Shared Thread Pieces & Duet ThreadDetailSheet

extension FleetHealth {
    var color: Color {
        switch self {
        case .red: return Theme.alert
        case .yellow: return Theme.caution
        case .green: return Theme.live
        case .gray: return Theme.muted
        }
    }
}

private struct HealthDot: View {
    let health: FleetHealth

    var body: some View {
        Circle().fill(health.color).frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

private struct HealthAndState: View {
    let thread: FleetThread
    var card: SupervisorCard? = nil
    let font: Font

    var body: some View {
        let badge = SupervisorFormat.statusBadge(thread: thread, card: card)
        let parts = badge.label.components(separatedBy: " · ")
        var label = AttributedString(parts.first ?? badge.label)
        label.foregroundColor = badge.health.color
        let restText = parts.count > 1 ? " · " + parts.dropFirst().joined(separator: " · ") : ""
        var rest = AttributedString(restText)
        rest.foregroundColor = Theme.muted
        return Text(label + rest).font(font)
    }
}

private struct NoteLine: View {
    let note: SupervisorFormat.Note

    var body: some View {
        Text(note.text)
            .font(Theme.Typography.caption)
            .foregroundStyle(note.isAlert ? Theme.alert : Theme.muted)
    }
}

private struct ThreadRow: View {
    let thread: FleetThread
    let hasProposal: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                HealthDot(health: FleetHealth.of(thread))
                Text(SupervisorFormat.name(thread))
                    .font(Theme.Typography.body)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let at = thread.lastActivityAt {
                    Text(RelativeTime.compact(minutes: Int(Date().timeIntervalSince(at) / 60)))
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HealthAndState(thread: thread, font: Theme.Typography.caption)
                if let line = thread.reason.flatMap({ $0.isEmpty ? nil : $0 }) ?? thread.blockers.first {
                    Text(line)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
                let chip = SupervisorFormat.prChip(thread.pr)
                let checkBadge = SupervisorQuietCheckFormatter.badge(nextCheckDate: thread.nextCheckAt)
                let threadLabels = Array(SupervisorBoardLabel.extract(from: thread.labels).prefix(3))
                let subSlug = thread.subchannel.flatMap { raw -> String? in
                    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return nil }
                    let clean = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
                    return clean.split(separator: "/").last.map(String.init) ?? clean
                }
                if chip != nil || hasProposal || thread.actorLabel != nil || checkBadge != nil || subSlug != nil {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Theme.Spacing.x2) {
                            if let actor = thread.actorLabel, !actor.isEmpty {
                                BoardActorPill(actor: actor)
                            }
                            if let subSlug {
                                Chip(text: "/\(subSlug)", color: Theme.muted)
                            }
                            if let chip {
                                Chip(text: chip, color: SupervisorFormat.ciFailing(thread.pr?.ci) ? Theme.alert : Theme.ink)
                            }
                            if let checkBadge {
                                BoardQuietCheckPill(label: checkBadge)
                            }
                            if hasProposal { Chip(text: "Nudge ready to send", color: Theme.live) }
                        }
                    }
                    .padding(.top, Theme.Spacing.x1)
                }
                if !threadLabels.isEmpty {
                    BoardReadOnlyLabelsRow(labels: threadLabels)
                        .padding(.top, 2)
                }
            }
            .padding(.leading, 18)
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

private struct Chip: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(Theme.Typography.caption)
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Spacing.x2)
            .padding(.vertical, 2)
            .background(Theme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct ThreadDetailSheet: View {
    let thread: FleetThread
    let proposed: [FleetAction]
    let busyActionID: String?
    let actionNote: (id: String, note: SupervisorFormat.Note)?
    let onSend: (FleetAction) -> Void
    var question: FleetQuestion? = nil
    var questionIsOpen = false
    var questionBusy = false
    var questionNote: SupervisorFormat.Note? = nil
    var onAnswer: (String) -> Void = { _ in }
    var onDefer: () -> Void = {}
    var card: SupervisorCard? = nil
    var onCardPrimary: (SupervisorCard, SupervisorCardAction) -> Void = { _, _ in }
    var onCardReply: ((SupervisorCard, String, [ChatAttachment]) async -> Bool)? = nil

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var activity: FleetThreadDetail?
    @State private var activityError: String?
    @State private var loadingActivity = false
    @State private var isNotFoundActivity = false
    @State private var replyOpen = false
    @State private var replyText = ""
    @State private var replyAttachments: [ChatAttachment] = []
    @State private var replySelectedPhotos: [PhotosPickerItem] = []
    @State private var showingReplyPhotos = false
    @State private var showingReplyFiles = false
    @State private var preparingReplyImages = false
    @State private var replyAttachmentError: String?
    @State private var directSendBusy = false
    @State private var directSendNote: SupervisorFormat.Note?

    private static let redundantMergeOptions: Set<String> = [
        "approved", "approve", "merge", "merged", "merge pr", "yes", "fix ci", "later", "dismiss", "hold", "open thread", "opened"
    ]

    private struct Detail: Identifiable {
        let id: String
        let label: String
        let value: String
        var valueColor: Color = Theme.ink
        var url: URL?
    }

    private func trimmedNonEmpty(_ value: String?) -> String? {
        guard let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        return v
    }

    private var headerTitle: String {
        trimmedNonEmpty(card?.sessionTitle)
            ?? trimmedNonEmpty(thread.title)
            ?? trimmedNonEmpty(card?.headline)
            ?? SupervisorFormat.name(thread)
    }

    private var effectivePRContext: SupervisorPRContext? {
        if let ctx = card?.prContext { return ctx }
        guard let pr = thread.pr else { return nil }
        return SupervisorPRContext(
            ref: pr.ref,
            url: pr.url,
            title: pr.title,
            bodySummary: pr.bodySummary,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            files: pr.files,
            ciState: pr.ci?.state
        )
    }

    private var effectivePRURL: URL? {
        if let raw = effectivePRContext?.url ?? card?.prUrl,
           let url = SupervisorFormat.prURL(FleetPR(ref: effectivePRContext?.ref ?? card?.prRef, url: raw)) {
            return url
        }
        return SupervisorFormat.prURL(thread.pr ?? FleetPR(ref: card?.prRef, url: card?.prUrl))
    }

    private var isMergeOrCiCard: Bool {
        card?.kind == "merge_ready"
            || card?.kind == "pr_ready"
            || card?.kind == "ci_failed"
            || card?.primaryAction?.op == "merge"
            || card?.primaryAction?.op == "fix_ci"
    }

    private var filteredQuestionOptions: [String] {
        let base: [String]
        if let question {
            base = SupervisorFormat.answerOptions(question)
        } else if let card {
            base = card.options.filter {
                let norm = $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                return !norm.isEmpty && !["dismiss", "later", "open thread", "opened"].contains(norm)
            }
        } else {
            return []
        }
        guard isMergeOrCiCard else { return base }
        return base.filter { opt in
            let norm = opt.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return !Self.redundantMergeOptions.contains(norm)
        }
    }

    private var hasSavedFallbackContext: Bool {
        !(card?.recentMessages.isEmpty ?? true)
            || trimmedNonEmpty(card?.agentSummary) != nil
            || trimmedNonEmpty(thread.lastAgentText) != nil
            || trimmedNonEmpty(effectivePRContext?.bodySummary) != nil
    }

    private var details: [Detail] {
        var rows: [Detail] = []
        if let reason = thread.reason, !reason.isEmpty { rows.append(Detail(id: "reason", label: "Reason", value: reason)) }
        if !thread.blockers.isEmpty {
            rows.append(Detail(id: "blockers", label: "Blockers", value: thread.blockers.map { "• \($0)" }.joined(separator: "\n")))
        }
        if let pr = thread.pr {
            let summary = [
                SupervisorFormat.prNumber(pr.ref),
                SupervisorFormat.ciLabel(pr.ci),
                pr.unresolvedThreads.flatMap { $0 > 0 ? "\($0) open threads" : nil },
                pr.state.map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() },
            ].compactMap { $0 }.joined(separator: " · ")
            let value = [summary.isEmpty ? nil : summary, pr.title.flatMap { $0.isEmpty ? nil : $0 }]
                .compactMap { $0 }.joined(separator: "\n")
            rows.append(Detail(id: "pr", label: "Pull request", value: value.isEmpty ? "Unknown" : value,
                               url: SupervisorFormat.prURL(pr)))
            if let failing = pr.ci?.failing, !failing.isEmpty {
                rows.append(Detail(id: "failing", label: "Failing checks", value: failing.joined(separator: "\n"), valueColor: Theme.alert))
            }
        }
        if let decision = thread.decision, let action = decision.action, !action.isEmpty, action != "none" {
            let next = [action, decision.playbook.map { "(\($0))" }].compactMap { $0 }.joined(separator: " ")
                + (decision.notBefore.map { ", not before " + SupervisorFormat.clockTime($0) } ?? "")
            rows.append(Detail(id: "next", label: "Next", value: next))
            if let why = decision.reason, !why.isEmpty { rows.append(Detail(id: "why", label: "Why", value: why)) }
        }
        if let error = thread.error {
            let text = SupervisorFormat.errorKindLabel(error.kind) + (error.resetAt.map { ", resets " + SupervisorFormat.clockTime($0) } ?? "")
            rows.append(Detail(id: "error", label: "Error", value: text, valueColor: Theme.alert))
        }
        let agent = [thread.kind, thread.agentStatus, thread.live ? "live" : nil].compactMap { $0 }.joined(separator: ", ")
        if !agent.isEmpty { rows.append(Detail(id: "agent", label: "Agent", value: agent)) }
        return rows
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(headerTitle).font(.headline)
                    HealthAndState(thread: thread, card: card, font: .subheadline)
                    let repoText = trimmedNonEmpty(thread.repo) ?? trimmedNonEmpty(card?.repo)
                    let branchText = trimmedNonEmpty(thread.branch) ?? trimmedNonEmpty(card?.branch)
                    if let repoText { Text(repoText).font(.caption).foregroundStyle(.secondary) }
                    if let branchText { Text(branchText).font(.caption.monospaced()).foregroundStyle(.secondary) }
                    if let url = effectivePRURL,
                       let prNum = SupervisorFormat.prNumber(effectivePRContext?.ref ?? card?.prRef ?? thread.pr?.ref) {
                        Button {
                            openURL(url)
                        } label: {
                            Label("Open Pull Request \(prNum) on GitHub", systemImage: "arrow.up.right.square")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.live)
                        }
                    }
                }

                if question != nil || card != nil {
                    Section("Needs your decision") {
                        let decisionTitle = trimmedNonEmpty(card?.headline) ?? trimmedNonEmpty(question?.title) ?? "Decision"
                        Text(decisionTitle).font(.headline)
                        if let ctx = trimmedNonEmpty(card?.brief?.context) {
                            Text(ctx).font(.footnote).foregroundStyle(.secondary)
                        }
                        let preferredSummary: String? = {
                            if let briefBody = trimmedNonEmpty(card?.brief?.whatChanged) { return briefBody }
                            let qBody = trimmedNonEmpty(question?.body)
                            let cSum = trimmedNonEmpty(card?.summary)
                            if let cSum, (cSum.count) > (qBody?.count ?? 0) { return cSum }
                            return qBody ?? cSum
                        }()
                        if let text = preferredSummary {
                            MarkdownContent(blocks: MarkdownParser.parse(text))
                        }
                        if let decisionCall = trimmedNonEmpty(card?.brief?.decision),
                           decisionCall.caseInsensitiveCompare(decisionTitle) != .orderedSame {
                            Text("Decision needed: \(decisionCall)")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                        }
                        if let rec = trimmedNonEmpty(card?.recommendation) {
                            Text(rec).font(.footnote).foregroundStyle(.secondary)
                        }

                        if let card, card.canReply, !card.suggestedReplies.isEmpty, questionIsOpen {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(Array(card.suggestedReplies.prefix(4).enumerated()), id: \.offset) { _, quick in
                                        Button {
                                            replyText = quick
                                            replyOpen = true
                                        } label: {
                                            Text(quick)
                                                .font(.caption)
                                                .padding(.horizontal, 10)
                                                .padding(.vertical, 6)
                                                .background(Theme.canvas, in: Capsule())
                                                .overlay(Capsule().strokeBorder(Theme.edge.opacity(0.6), lineWidth: 1))
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(questionBusy)
                                    }
                                }
                            }
                        }

                        if questionIsOpen {
                            decisionActionBar
                        } else {
                            Text("This question has been handled.").font(.footnote).foregroundStyle(.secondary)
                        }

                        if replyOpen, let card {
                            VStack(alignment: .leading, spacing: 8) {
                                TextField("Send instructions or screenshots to this coding session…", text: $replyText, axis: .vertical)
                                    .lineLimit(2...5)
                                    .textFieldStyle(.roundedBorder)
                                replyAttachmentSection(disabled: questionBusy || preparingReplyImages)
                                HStack(spacing: 10) {
                                    let trimmed = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
                                    let canSendReply = !questionBusy && !preparingReplyImages && (!trimmed.isEmpty || !replyAttachments.isEmpty)
                                    Button("Send to session") {
                                        let effectiveText = trimmed.isEmpty ? "Please inspect the attached image(s)." : trimmed
                                        let sentImages = replyAttachments
                                        if let onCardReply {
                                            Task {
                                                let delivered = await onCardReply(card, effectiveText, sentImages)
                                                if delivered {
                                                    replyText = ""
                                                    replyAttachments = []
                                                    replyOpen = false
                                                }
                                            }
                                        } else {
                                            onCardPrimary(card, SupervisorCardAction(op: "reply", label: "Reply", value: effectiveText))
                                            replyText = ""
                                            replyAttachments = []
                                            replyOpen = false
                                        }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(!canSendReply)

                                    Button("Cancel") {
                                        replyOpen = false
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                            .padding(.top, 4)
                        }

                        if let questionNote { NoteLine(note: questionNote) }
                    }
                }

                if let prCtx = effectivePRContext,
                   (trimmedNonEmpty(prCtx.title) != nil
                    || trimmedNonEmpty(prCtx.bodySummary) != nil
                    || SupervisorFormat.diffStatLine(prCtx) != nil
                    || !prCtx.files.isEmpty
                    || !prCtx.gates.isEmpty) {
                    Section("What changed") {
                        if let title = trimmedNonEmpty(prCtx.title) {
                            Text(title).font(.subheadline.weight(.semibold))
                        }
                        if let diffLine = SupervisorFormat.diffStatLine(prCtx) {
                            Text(diffLine)
                                .font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        if let bodySummary = trimmedNonEmpty(prCtx.bodySummary) {
                            MarkdownContent(blocks: MarkdownParser.parse(bodySummary))
                        }
                        if !prCtx.gates.isEmpty {
                            FlowLayout(spacing: 6) {
                                ForEach(prCtx.gates) { gate in
                                    Chip(
                                        text: gate.state.map { "\(gate.label): \($0)" } ?? gate.label,
                                        color: Theme.ink
                                    )
                                }
                            }
                        }
                        if !prCtx.files.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Changed files")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                ForEach(prCtx.files.prefix(10), id: \.self) { file in
                                    Text(file)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(Theme.ink)
                                }
                            }
                        }
                    }
                }

                Section("Recent thread activity") {
                    if loadingActivity && activity == nil { ProgressView("Loading thread activity…") }
                    if let activityError {
                        if isNotFoundActivity && hasSavedFallbackContext {
                            Text("Showing saved context from this coding session.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Label(activityError, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                            Button("Retry") { Task { await loadActivity() } }
                        }
                    }
                    if let activity {
                        if let at = activity.scannedAt {
                            Text("From the latest scan · \(SupervisorFormat.agoPhrase(at))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let owner = activity.lastOwnerMessage, let text = owner.text, !text.isEmpty {
                            activityMessage("You", text: text, at: owner.at)
                        } else if let at = activity.lastOwnerAt {
                            Text("You last replied \(SupervisorFormat.agoPhrase(at)). The message text is unavailable.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if let agent = activity.lastAgentMessage, let text = agent.text, !text.isEmpty {
                            activityMessage("Agent", text: text, at: agent.at)
                        } else if let savedAgent = trimmedNonEmpty(card?.agentSummary) ?? trimmedNonEmpty(thread.lastAgentText) {
                            activityMessage("Agent", text: savedAgent, at: thread.lastActivityAt)
                        } else {
                            Text("No agent message was available in this scan.").foregroundStyle(.secondary)
                        }
                        if activity.activityTruncated == true {
                            Text("Showing the most recent part of a long message. Read the full conversation in the original app before deciding.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } else if let recent = card?.recentMessages, !recent.isEmpty {
                        ForEach(recent) { msg in
                            activityMessage(msg.role == "user" ? "You" : "Agent", text: msg.text, at: msg.at)
                        }
                    } else if let savedAgent = trimmedNonEmpty(card?.agentSummary) ?? trimmedNonEmpty(thread.lastAgentText) {
                        activityMessage("Agent", text: savedAgent, at: thread.lastActivityAt)
                    }
                    NavigationLink {
                        FleetConversationView(
                            thread: thread,
                            fallbackMessages: card?.recentMessages ?? [],
                            fallbackSummary: trimmedNonEmpty(card?.agentSummary) ?? trimmedNonEmpty(thread.lastAgentText)
                        )
                    } label: {
                        Label("Read conversation", systemImage: "text.bubble")
                    }
                    .accessibilityIdentifier("supervisor-read-conversation")
                }

                if !details.isEmpty {
                    Section("Thread status") {
                        ForEach(details) { detail in detailRow(detail) }
                    }
                }
                if let timeline = card?.timeline, !timeline.isEmpty {
                    Section("Decisions and updates") {
                        ForEach(timeline) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(item.label).font(.subheadline.weight(.medium))
                                    Spacer()
                                    if let at = item.at {
                                        Text(SupervisorFormat.clockTime(at)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                if let detail = item.detail, !detail.isEmpty {
                                    Text(detail).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
                if let resources = card?.resources, !resources.isEmpty {
                    Section("Resources") {
                        ForEach(resources) { res in
                            if let raw = res.url, let url = URL(string: raw), url.scheme == "https" {
                                Button {
                                    openURL(url)
                                } label: {
                                    HStack {
                                        Label(res.label, systemImage: "arrow.up.right.square")
                                        Spacer()
                                    }
                                }
                            } else {
                                Label(res.label, systemImage: "doc.text")
                                    .font(.subheadline)
                            }
                        }
                    }
                }
                ForEach(proposed) { action in
                    Section("Proposed nudge") {
                        if let message = action.message { Text(message) }
                        if let why = action.detail ?? action.reason { Text(why).foregroundStyle(.secondary) }
                        Button("Send") { onSend(action) }.disabled(busyActionID != nil)
                        if let actionNote, actionNote.id == action.id { NoteLine(note: actionNote.note) }
                    }
                }
                if let actionNote, !proposed.contains(where: { $0.id == actionNote.id }) {
                    NoteLine(note: actionNote.note)
                }
                if card == nil && thread.key.hasPrefix("paseo:") {
                    Section("Message coding session") {
                        TextField("Send message or attach images…", text: $replyText, axis: .vertical)
                            .lineLimit(2...5)
                        replyAttachmentSection(disabled: directSendBusy || preparingReplyImages)
                        let trimmed = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
                        let canDirectSend = !directSendBusy && !preparingReplyImages && (!trimmed.isEmpty || !replyAttachments.isEmpty)
                        Button {
                            let effectiveText = trimmed.isEmpty ? "Please inspect the attached image(s)." : trimmed
                            let sentImages = replyAttachments
                            Task {
                                directSendBusy = true
                                directSendNote = nil
                                defer { directSendBusy = false }
                                do {
                                    let res = try await model.client.fleetSendMessage(
                                        threadKey: thread.key,
                                        message: effectiveText,
                                        images: sentImages
                                    )
                                    let note = SupervisorFormat.deliveryNote(res.delivery, fallback: "Sent to coding session.")
                                    directSendNote = note
                                    if !note.isAlert {
                                        replyText = ""
                                        replyAttachments = []
                                    }
                                } catch let err as DaemonError {
                                    directSendNote = SupervisorFormat.failureNote(err)
                                } catch {
                                    directSendNote = .init(text: "Couldn't reach OpenAGI.", isAlert: true)
                                }
                            }
                        } label: {
                            Label(directSendBusy ? "Sending…" : "Send to session", systemImage: "paperplane.fill")
                        }
                        .disabled(!canDirectSend)
                        if let directSendNote {
                            NoteLine(note: directSendNote)
                        }
                    }
                }
            }
            .accessibilityIdentifier("supervisor-thread-details")
            .listStyle(.insetGrouped)
            .navigationTitle("Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .photosPicker(
                isPresented: $showingReplyPhotos,
                selection: $replySelectedPhotos,
                maxSelectionCount: max(1, ChatAttachment.maximumCount - replyAttachments.count),
                matching: .images
            )
            .onChange(of: replySelectedPhotos) { _, items in
                guard !items.isEmpty else { return }
                Task { await importReplyPhotos(items) }
            }
            .fileImporter(isPresented: $showingReplyFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                Task { await importReplyFiles(result) }
            }
            .refreshable { await loadActivity() }
            .task(id: thread.key) { await loadActivity() }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func replyAttachmentSection(disabled: Bool) -> some View {
        if !replyAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(replyAttachments) { attachment in
                        ZStack(alignment: .topTrailing) {
                            ChatAttachmentImage(attachment: attachment)
                                .frame(width: 68, height: 68)
                                .clipShape(.rect(cornerRadius: 10))
                            Button("Remove image", systemImage: "xmark.circle.fill") {
                                replyAttachments.removeAll { $0.id == attachment.id }
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.circle)
                        }
                    }
                }
            }
        }
        Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { showingReplyPhotos = true }
            Button("Paste Image", systemImage: "doc.on.clipboard") {
                Task { await pasteReplyImages() }
            }
            Button("Choose Image File", systemImage: "folder") { showingReplyFiles = true }
        } label: {
            Label("Attach or paste image", systemImage: "plus.circle")
                .font(.footnote.weight(.medium))
        }
        .disabled(disabled || replyAttachments.count >= ChatAttachment.maximumCount)
        if preparingReplyImages {
            ProgressView("Preparing images…").font(.caption)
        }
        if let replyAttachmentError {
            Text(replyAttachmentError).font(.caption).foregroundStyle(.red)
        }
    }

    private func importReplyPhotos(_ photos: [PhotosPickerItem]) async {
        guard !preparingReplyImages else { return }
        preparingReplyImages = true
        replyAttachmentError = nil
        defer {
            preparingReplyImages = false
            replySelectedPhotos = []
        }
        do {
            let remaining = ChatAttachment.maximumCount - replyAttachments.count
            for photo in photos.prefix(max(0, remaining)) {
                guard let data = try await photo.loadTransferable(type: Data.self) else {
                    throw ChatAttachmentPreparation.Failure.unreadable
                }
                replyAttachments.append(try await ChatAttachmentPreparation.prepare(data, name: "Photo.jpg"))
            }
        } catch {
            replyAttachmentError = error.localizedDescription
        }
    }

    private func importReplyFiles(_ result: Result<[URL], Error>) async {
        guard !preparingReplyImages else { return }
        preparingReplyImages = true
        replyAttachmentError = nil
        defer { preparingReplyImages = false }
        do {
            let urls = try result.get()
            let remaining = ChatAttachment.maximumCount - replyAttachments.count
            for url in urls.prefix(max(0, remaining)) {
                replyAttachments.append(try await ChatAttachmentPreparation.file(url))
            }
        } catch {
            replyAttachmentError = error.localizedDescription
        }
    }

    private func pasteReplyImages() async {
        guard !preparingReplyImages else { return }
        let remaining = ChatAttachment.maximumCount - replyAttachments.count
        guard remaining > 0 else {
            replyAttachmentError = "Attach up to four images per message."
            return
        }
        let rawImages: [UIImage] = UIPasteboard.general.images ?? (UIPasteboard.general.image.map { [$0] } ?? [])
        guard !rawImages.isEmpty else {
            replyAttachmentError = "Clipboard doesn't contain an image."
            return
        }
        preparingReplyImages = true
        replyAttachmentError = nil
        defer { preparingReplyImages = false }
        do {
            for img in rawImages.prefix(remaining) {
                guard let data = img.pngData() ?? img.jpegData(compressionQuality: 0.9) else {
                    throw ChatAttachmentPreparation.Failure.unreadable
                }
                replyAttachments.append(try await ChatAttachmentPreparation.prepare(data, name: "Pasted image.jpg"))
            }
        } catch {
            replyAttachmentError = error.localizedDescription
        }
    }

    @ViewBuilder
    private var decisionActionBar: some View {
        let options = filteredQuestionOptions
        let extras = (card?.extraActions ?? []).filter { $0.op != "defer" && $0.op != "dismiss" && !$0.label.isEmpty }
        VStack(alignment: .leading, spacing: 8) {
            FlowLayout(spacing: 8) {
                if let card, isMergeOrCiCard, let primary = card.primaryAction, !primary.label.isEmpty {
                    DeckPillButton(title: questionBusy ? "Working…" : primary.label, filled: true, enabled: !questionBusy) {
                        onCardPrimary(card, primary)
                    }
                    ForEach(Array(extras.enumerated()), id: \.offset) { _, extra in
                        DeckPillButton(title: extra.label, filled: false, enabled: !questionBusy) {
                            onCardPrimary(card, extra)
                        }
                    }
                }
                ForEach(Array(options.enumerated()), id: \.element) { idx, option in
                    DeckPillButton(title: option, filled: !isMergeOrCiCard && idx == 0, enabled: !questionBusy) {
                        if option == "Answer question" {
                            replyOpen = true
                        } else {
                            onAnswer(option)
                        }
                    }
                }
                if card != nil {
                    DeckPillButton(title: replyOpen ? "Close reply" : "Reply", filled: false, enabled: !questionBusy) {
                        replyOpen.toggle()
                    }
                }
                DeckPillButton(title: "Later", filled: false, enabled: !questionBusy) {
                    onDefer()
                }
            }
            if options.isEmpty && !isMergeOrCiCard {
                Label("Respond in the original app on your Mac. Reading this thread does not send an answer.", systemImage: "macbook")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 4)
    }

    private func activityMessage(_ speaker: String, text: String, at: Date?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(speaker).font(.subheadline.weight(.semibold))
                if let at { Text(SupervisorFormat.clockTime(at)).font(.caption).foregroundStyle(.secondary) }
            }
            MarkdownContent(blocks: MarkdownParser.parse(text)).textSelection(.enabled)
            let milestones = SupervisorMilestoneParser.parse(from: text)
            if !milestones.isEmpty {
                BoardMilestoneStrip(milestones: milestones)
            }
        }
        .accessibilityIdentifier("thread-activity-\(speaker.lowercased())")
    }

    private func loadActivity() async {
        guard !loadingActivity, !thread.key.hasPrefix("fleet:") else { return }
        loadingActivity = true
        defer { loadingActivity = false }
        do {
            activity = try await model.client.fleetThreadDetail(key: thread.key)
            activityError = nil
            isNotFoundActivity = false
        } catch let error as DaemonError {
            isNotFoundActivity = (error == .notFound)
            activityError = error == .notFound
                ? "This thread is no longer in the latest scan. Its saved context is shown below."
                : SupervisorFormat.errorCopy(error).detail
        } catch {
            isNotFoundActivity = false
            activityError = "Couldn't load the thread activity. Your question has not been changed."
        }
    }

    @ViewBuilder
    private func detailRow(_ detail: Detail) -> some View {
        let content = VStack(alignment: .leading, spacing: 2) {
            Text(detail.label)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.muted)
            Text(detail.value)
                .font(Theme.Typography.body)
                .foregroundStyle(detail.valueColor)
            if detail.url != nil {
                Text("Open in browser")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.live)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, Theme.Spacing.x3)

        if let url = detail.url {
            Button { openURL(url) } label: { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
        } else {
            content
        }
    }
}

// Left-to-right wrapping row, for a question's answer buttons: a handful of
// options of unknown length must wrap rather than squeeze or clip.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews: subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews: subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
