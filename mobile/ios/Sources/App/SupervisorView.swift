import SwiftUI

// mobile/FEATURES.md's Supervisor tab: one fluid conversation with the fleet
// supervisor ("supervisor" shared thread) paired with a pinned, swipeable
// Decision Card deck above the composer (Claude Duet style), a compact active
// sessions & BM25 search sheet in the toolbar, progressive non-auto-merge
// preferences, and a Scrutinizer autonomy banner with 1-tap veto.
struct SupervisorView: View {
    var showsInlineChat = true
    @Environment(AppModel.self) private var model

    @State private var state: FleetState?
    @State private var loadError: DaemonError?
    @State private var lastLoadFailed = false
    @State private var scanning = false
    @State private var statusNote: SupervisorFormat.Note?
    @State private var modeBusy = false
    @State private var confirmAuto = false
    @State private var busyCardID: String?
    @State private var busyQuestionID: String?
    @State private var questionNote: (id: String, note: SupervisorFormat.Note)?
    @State private var busyActionID: String?
    @State private var actionNote: (id: String, note: SupervisorFormat.Note)?
    @State private var actionNoteThread: String?
    @State private var selectedCardIndex = 0
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

    private var clampedCardIndex: Int {
        guard !cards.isEmpty else { return 0 }
        return min(max(0, selectedCardIndex), cards.count - 1)
    }

    private var currentCard: SupervisorCard? {
        guard !cards.isEmpty else { return nil }
        return cards[clampedCardIndex]
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
                title: "Supervisor",
                scrollToMessageID: selectedMessage,
                placeholder: focusedPlaceholder,
                emptyDetail: "One project manager across your coding agents. Review decisions below, route a bug, or ask about any repo.",
                topAccessory: AnyView(topBannerStack),
                composerAccessory: { focused in AnyView(deckAccessory(composerFocused: focused)) },
                onHistorySelectionConsumed: { selectedMessage = nil }
            )
            .id(conversation.identity)
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    activeSessionsPill
                    overflowMenu
                }
            }
        }
        .task(id: model.fleetGeneration) { await refresh() }
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
            let question = opened.question ?? opened.card?.questionId.flatMap { qid in
                state?.questions.first(where: { $0.id == qid })
            }
            let card = opened.card ?? cards.first(where: { $0.id == opened.card?.id || ($0.questionId != nil && $0.questionId == question?.id) })
            ThreadDetailSheet(
                thread: thread,
                proposed: state?.mode == FleetMode.propose.rawValue
                    ? SupervisorFormat.proposed(for: thread, in: state?.actions ?? []) : [],
                busyActionID: busyActionID,
                actionNote: actionNoteThread == thread.key ? actionNote : nil,
                onSend: { action in Task { await send(action) } },
                question: question,
                questionIsOpen: question.map { q in state?.questions.contains(where: { $0.id == q.id }) == true } ?? false,
                questionBusy: busyQuestionID != nil || busyCardID != nil,
                questionNote: question.flatMap { q in questionNote?.id == q.id ? questionNote?.note : nil },
                onAnswer: { answer in
                    if let question { Task { await decide(question, answer: answer) } }
                },
                card: card,
                onCardPrimary: { targetCard, action in
                    Task { await act(targetCard, action: action) }
                }
            )
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .sessions:
                ActiveSessionsSheet(
                    state: state,
                    scanning: scanning || state?.running == true,
                    onScan: { Task { await scan() } },
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

    private var overflowMenu: some View {
        Menu {
            let isScanning = scanning || state?.running == true
            Button(isScanning ? "Scanning…" : "Scan now", systemImage: "arrow.clockwise") {
                Task { await scan() }
            }
            .disabled(isScanning)

            Button("Active sessions & search", systemImage: "magnifyingglass") {
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
                browserThread = .supervisor
                activeSheet = .conversations
            }
            .accessibilityIdentifier("supervisor-conversations")
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
                    cards: cards,
                    index: clampedCardIndex,
                    focusedCardID: conversation.focusedCardID,
                    busyCardID: busyCardID ?? busyQuestionID,
                    threads: state?.snapshot?.threads ?? [],
                    onSelectIndex: { newIndex in
                        selectedCardIndex = min(max(0, newIndex), max(0, cards.count - 1))
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
        if let key {
            let thread = threads.first(where: { $0.key == key })
                ?? FleetThread(key: key, title: card.headline, workspace: card.workspace, repo: card.repo, branch: card.branch)
            openThread = ThreadPresentation(thread: thread, question: question, card: card)
            actionNote = nil
        } else if let question {
            openThread = ThreadPresentation(
                thread: FleetThread(key: "fleet:\(question.id)", title: card.headline),
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
        do {
            let fresh = try await model.client.fleetState()
            accept(sequence, fresh)
        } catch let error as DaemonError {
            reject(sequence, error)
        } catch {
            reject(sequence, .transport(error))
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

    private func act(_ card: SupervisorCard, action: SupervisorCardAction) async {
        guard busyCardID == nil && busyQuestionID == nil else { return }
        busyCardID = card.id
        statusNote = nil
        defer { busyCardID = nil }

        let daemonHasCards = !(state?.cards.isEmpty ?? true)
        do {
            let result = try await model.client.fleetActCard(id: card.id, op: action.op, value: action.value)
            let note = SupervisorFormat.cardActNote(result)
            statusNote = note
            if let qid = card.questionId { questionNote = (qid, note) }
            if let fresh = result.state {
                accept(nextSequence(), fresh)
            } else {
                await refresh()
            }
        } catch DaemonError.notFound where !daemonHasCards && card.questionId != nil {
            // Older daemon fallback: translate card action to legacy /fleet/api/questions/:id.
            if let qid = card.questionId, let q = state?.questions.first(where: { $0.id == qid }) {
                busyCardID = nil
                if action.op == "defer" || action.op == "dismiss" {
                    await decide(q, answer: nil)
                } else {
                    await decide(q, answer: action.value ?? SupervisorFormat.answerOptions(q).first)
                }
            }
        } catch let error as DaemonError {
            let note = SupervisorFormat.failureNote(error)
            statusNote = note
            if let qid = card.questionId { questionNote = (qid, note) }
            if error == .conflict || error == .notFound { await refresh() }
        } catch {
            statusNote = .init(text: "Can't reach OpenAGI.", isAlert: true)
        }
    }

    // answer == nil is a dismissal.
    private func decide(_ question: FleetQuestion, answer: String?) async {
        guard busyQuestionID == nil else { return }
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
        } catch let error as DaemonError {
            let note = SupervisorFormat.failureNote(error)
            questionNote = (question.id, note)
            statusNote = note
            if error == .conflict || error == .notFound { await refresh() }
        } catch {
            let note = SupervisorFormat.Note(text: "Can't reach OpenAGI.", isAlert: true)
            questionNote = (question.id, note)
            statusNote = note
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

    private var card: SupervisorCard { cards[index] }
    private var isBusy: Bool { busyCardID != nil }
    private var hasThreadContext: Bool {
        card.threadKey != nil || !card.threadKeys.isEmpty
    }

    private var subtitleLine: String {
        let about: String?
        if card.threadKeys.count > 1 {
            about = "\(card.threadKeys.count) threads"
        } else if let ws = card.workspace, !ws.isEmpty {
            about = ws
        } else if let repo = card.repo, !repo.isEmpty {
            about = repo
        } else if let key = card.threadKey, let thread = threads.first(where: { $0.key == key }) {
            about = SupervisorFormat.name(thread)
        } else {
            about = nil
        }
        let ci = card.ciState.flatMap { SupervisorFormat.ciLabel(FleetCI(state: $0)) }
        let pr = SupervisorFormat.prNumber(card.prRef)
        let ago = card.noticedAt.map { SupervisorFormat.agoPhrase($0) }
        return [about, pr, ci, ago].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Deck header: kind badge + 1 of N stepper + focus chip
            HStack(spacing: 8) {
                Text((card.kindLabel ?? "Needs you").uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(card.risky ? Theme.caution : Theme.live)

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

            // Action bar
            cardActions
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: 600, alignment: .leading)
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
            if let summary = card.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                Text(MarkdownParser.inline(summary))
                    .font(Theme.Typography.secondary)
                    .foregroundStyle(Theme.ink.opacity(0.9))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            if let rec = card.recommendation?.trimmingCharacters(in: .whitespacesAndNewlines), !rec.isEmpty {
                Text(rec)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
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

                if card.kind != "preference" {
                    DeckPillButton(title: "Reply", filled: false, enabled: !isBusy) {
                        onReplyInChat(card)
                    }
                    .accessibilityIdentifier("supervisor-card-reply-\(card.id)")
                }

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
                        onAct(card, SupervisorCardAction(op: "answer", label: option, value: option))
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
    let scanning: Bool
    let onScan: () -> Void
    let onSelectThread: (FleetThread) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var searchHits: [FleetSearchHit] = []
    @State private var isSearching = false
    @State private var searchError: String?

    private var threads: [FleetThread] {
        SupervisorFormat.sorted(state?.snapshot?.threads ?? [])
    }

    var body: some View {
        NavigationStack {
            List {
                if let state {
                    Section {
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
                                    let existing = threads.first(where: { $0.key == hit.key })
                                    let thread = existing ?? FleetThread(
                                        key: hit.key,
                                        title: hit.title,
                                        workspace: hit.workspace,
                                        repo: hit.repo,
                                        branch: hit.branch,
                                        state: hit.state,
                                        health: hit.health,
                                        pr: hit.prRef.map { FleetPR(ref: $0) },
                                        live: hit.live
                                    )
                                    onSelectThread(thread)
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(hit.workspace ?? hit.title ?? hit.key)
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
                                    onSelectThread(thread)
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
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "Search repos, PRs, branches, transcripts")
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
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
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
    let font: Font

    var body: some View {
        let health = FleetHealth.of(thread)
        var label = AttributedString(SupervisorFormat.healthLabel(health))
        label.foregroundColor = health.color
        var rest = AttributedString(" · " + SupervisorFormat.stateLabel(thread.state))
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
                if chip != nil || hasProposal {
                    HStack(spacing: Theme.Spacing.x2) {
                        if let chip {
                            Chip(text: chip, color: SupervisorFormat.ciFailing(thread.pr?.ci) ? Theme.alert : Theme.ink)
                        }
                        if hasProposal { Chip(text: "Nudge ready to send", color: Theme.live) }
                    }
                    .padding(.top, Theme.Spacing.x1)
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
    var card: SupervisorCard? = nil
    var onCardPrimary: (SupervisorCard, SupervisorCardAction) -> Void = { _, _ in }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var activity: FleetThreadDetail?
    @State private var activityError: String?
    @State private var loadingActivity = false

    private struct Detail: Identifiable {
        let id: String
        let label: String
        let value: String
        var valueColor: Color = Theme.ink
        var url: URL?
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
                    Text(thread.title ?? SupervisorFormat.name(thread)).font(.headline)
                    HealthAndState(thread: thread, font: .subheadline)
                    if let repo = thread.repo { Text(repo).font(.caption).foregroundStyle(.secondary) }
                    if let branch = thread.branch { Text(branch).font(.caption.monospaced()).foregroundStyle(.secondary) }
                }
                if let question {
                    Section("Needs your decision") {
                        Text(question.title ?? "Question").font(.headline)
                        if let text = question.body { MarkdownContent(blocks: MarkdownParser.parse(text)) }
                    }
                } else if let card {
                    Section("Needs your decision") {
                        Text(card.headline).font(.headline)
                        if let text = card.summary { MarkdownContent(blocks: MarkdownParser.parse(text)) }
                    }
                }
                Section("Recent thread activity") {
                    if loadingActivity && activity == nil { ProgressView("Loading thread activity…") }
                    if let activityError {
                        Label(activityError, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                        Button("Retry") { Task { await loadActivity() } }
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
                        } else {
                            Text("No agent message was available in this scan.").foregroundStyle(.secondary)
                        }
                        if activity.activityTruncated == true {
                            Text("Showing the most recent part of a long message. Read the full conversation in the original app before deciding.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } else if let text = thread.lastAgentText, !text.isEmpty {
                        activityMessage("Saved scan excerpt", text: text, at: thread.lastActivityAt)
                    }
                    NavigationLink {
                        FleetConversationView(thread: thread)
                    } label: {
                        Label("Read conversation", systemImage: "text.bubble")
                    }
                    .accessibilityIdentifier("supervisor-read-conversation")
                }
                if let question {
                    Section("Your response") {
                        if questionIsOpen {
                            let isMergeCard = card?.kind == "merge_ready" || card?.kind == "pr_ready"
                                || card?.primaryAction?.op == "merge" || card?.primaryAction?.op == "fix_ci"
                            if let card, isMergeCard, let primary = card.primaryAction {
                                Button(primary.label) {
                                    onCardPrimary(card, primary)
                                }
                                .font(.body.weight(.semibold))
                                .disabled(questionBusy)
                            }
                            let options = SupervisorFormat.answerOptions(question)
                            ForEach(options, id: \.self) { option in
                                Button(option) { onAnswer(option) }.disabled(questionBusy)
                            }
                            if options.isEmpty && !isMergeCard {
                                Label("Respond in the original app on your Mac. Reading this thread does not send an answer.", systemImage: "macbook")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        } else {
                            Text("This question has been handled.").foregroundStyle(.secondary)
                        }
                        if let questionNote { NoteLine(note: questionNote) }
                    }
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
            }
            .accessibilityIdentifier("supervisor-thread-details")
            .listStyle(.insetGrouped)
            .navigationTitle("Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await loadActivity() }
            .task(id: thread.key) { await loadActivity() }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func activityMessage(_ speaker: String, text: String, at: Date?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(speaker).font(.subheadline.weight(.semibold))
                if let at { Text(SupervisorFormat.clockTime(at)).font(.caption).foregroundStyle(.secondary) }
            }
            MarkdownContent(blocks: MarkdownParser.parse(text)).textSelection(.enabled)
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
        } catch let error as DaemonError {
            activityError = error == .notFound
                ? "This thread is no longer in the latest scan. Its saved context is shown below."
                : SupervisorFormat.errorCopy(error).detail
        } catch {
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
