import SwiftUI

// mobile/FEATURES.md's Supervisor tab: the fleet supervisor's view of every
// coding thread, read from /fleet/api/state. What needs a person comes first
// (its open questions), then every thread, worst health first. The mode, a
// manual scan and a supervisor chat sit in the header. Nothing here is
// optimistic: a mode change, an answer or a sent nudge shows only once the
// daemon says so, the same rule approvals follow. Mirrors Android's
// SupervisorScreen.kt, wording included.
struct SupervisorView: View {
    @Environment(AppModel.self) private var model

    @State private var state: FleetState?
    @State private var loadError: DaemonError?
    @State private var lastSyncedAt: Date?
    @State private var lastLoadFailed = false
    @State private var scanning = false
    @State private var scanNote: SupervisorFormat.Note?
    @State private var modeBusy = false
    @State private var modeNote: SupervisorFormat.Note?
    @State private var confirmAuto = false
    @State private var busyQuestionID: String?
    @State private var questionNote: (id: String, note: SupervisorFormat.Note)?
    @State private var busyActionID: String?
    @State private var actionNote: (id: String, note: SupervisorFormat.Note)?
    // The thread whose sheet started the send: the sheet can be closed and
    // another thread opened while a nudge relays, and the result is not theirs.
    @State private var actionNoteThread: String?
    @State private var openThread: FleetThread?
    @State private var chatOpen = false
    // Responses can land out of order: a 30s poll sent while an answer was
    // relaying may return after it with the state from before. A poll is
    // numbered when sent, a mutation's reply when it arrives, and nothing
    // older than what is already on screen replaces it.
    @State private var issued = 0
    @State private var applied = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.x6) {
                    ScreenHeader(title: "Supervisor", host: model.credentials.server.host ?? "",
                                 ageMinutes: syncedAgeMinutes, refreshFailed: lastLoadFailed)
                        .padding(.horizontal, -Theme.gutter)
                    content
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, Theme.Spacing.x6)
            }
            .background(Theme.canvas)
            .refreshable { await refresh() }
            .task(id: model.fleetGeneration) { await refresh() }
            // Every 30s while this screen is showing; every 5s while the
            // daemon reports a scan running, so "Scanning…" clears soon after
            // it finishes. Cancelled with the view (another tab, or the
            // supervisor chat pushed over it).
            .task(id: chatOpen) {
                guard !chatOpen else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(state?.running == true ? 5 : 30))
                    if Task.isCancelled { break }
                    await refresh()
                }
            }
            .navigationDestination(isPresented: $chatOpen) {
                ChatConversationView(
                    conversation: model.supervisorChat,
                    title: "Supervisor",
                    starters: SupervisorFormat.starters,
                    placeholder: "Ask the supervisor",
                    emptyDetail: "Ask about any coding thread it watches."
                )
                .navigationBarTitleDisplayMode(.inline)
            }
            .sheet(item: $openThread) { opened in
                // Follow the thread through refreshes; if a scan drops it,
                // keep showing what was last known rather than yanking it away.
                let thread = state?.snapshot?.threads.first(where: { $0.key == opened.key }) ?? opened
                ThreadDetailSheet(
                    thread: thread,
                    proposed: state?.mode == FleetMode.propose.rawValue
                        ? SupervisorFormat.proposed(for: thread, in: state?.actions ?? []) : [],
                    busyActionID: busyActionID,
                    actionNote: actionNoteThread == thread.key ? actionNote : nil,
                    onSend: { action in Task { await send(action) } }
                )
            }
            .alert("Turn on Auto?", isPresented: $confirmAuto) {
                Button("Turn on Auto") { Task { await setMode(.auto) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("In Auto the supervisor sends preset nudges to your agents by itself, a few per scan, without asking first. Observe and Propose never send on their own.")
            }
        }
    }

    private var syncedAgeMinutes: Int {
        guard let lastSyncedAt else { return 0 }
        return max(0, Int(Date().timeIntervalSince(lastSyncedAt) / 60))
    }

    @ViewBuilder
    private var content: some View {
        if let loadError, state == nil || SupervisorFormat.isUnavailable(loadError) {
            let copy = SupervisorFormat.errorCopy(loadError)
            EmptyStateView(headline: copy.headline, detail: copy.detail)
        } else if let state {
            controls(state)
            needsYou(state)
            threads(state)
        } else {
            EmptyStateView(headline: "Loading…", detail: "Reading the supervisor on your main.")
        }
    }

    // MARK: - Loading and mutations

    private func accept(_ sequence: Int, _ fresh: FleetState) {
        guard sequence >= applied else { return }
        applied = sequence
        state = fresh
        loadError = nil
        lastLoadFailed = false
        lastSyncedAt = Date()
    }

    private func reject(_ sequence: Int, _ error: DaemonError) {
        guard sequence >= applied else { return }
        applied = sequence
        loadError = error
        // A daemon without a supervisor answered, so it is reachable: the
        // connection line must not claim otherwise.
        lastLoadFailed = !SupervisorFormat.isUnavailable(error)
        if !lastLoadFailed { lastSyncedAt = Date() }
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
        scanNote = nil
        defer { scanning = false }
        do {
            let fresh = try await model.client.fleetScan()
            accept(nextSequence(), fresh)
        } catch let error as DaemonError {
            scanNote = SupervisorFormat.isTimeout(error)
                ? .init(text: "The scan is taking a while. Pull to refresh in a minute.", isAlert: false)
                : .init(text: SupervisorFormat.errorCopy(error).headline, isAlert: true)
            await refresh()
        } catch {
            await refresh()
        }
    }

    private func requestMode(_ mode: FleetMode) {
        guard !modeBusy, state?.mode != mode.rawValue else { return }
        // Tapping Auto while already in Auto must not ask to turn it on.
        if mode == .auto { confirmAuto = true } else { Task { await setMode(mode) } }
    }

    private func setMode(_ mode: FleetMode) async {
        guard !modeBusy, state?.mode != mode.rawValue else { return }
        modeBusy = true
        modeNote = nil
        defer { modeBusy = false }
        do {
            let fresh = try await model.client.fleetSetMode(mode)
            accept(nextSequence(), fresh)
        } catch let error as DaemonError {
            modeNote = .init(text: SupervisorFormat.errorCopy(error).headline, isAlert: true)
        } catch {
            modeNote = .init(text: "Can't reach OpenAGI.", isAlert: true)
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
                ? SupervisorFormat.Note(text: "Dismissed.", isAlert: false)
                : SupervisorFormat.deliveryNote(result.delivery, fallback: "Answered.")
            questionNote = (question.id, note)
            if let fresh = result.state { accept(nextSequence(), fresh) } else { await refresh() }
        } catch let error as DaemonError {
            questionNote = (question.id, SupervisorFormat.failureNote(error))
            // Closed or gone elsewhere: show what is actually open now.
            if error == .conflict || error == .notFound { await refresh() }
        } catch {
            questionNote = (question.id, .init(text: "Can't reach OpenAGI.", isAlert: true))
        }
    }

    private func send(_ action: FleetAction) async {
        guard busyActionID == nil else { return }
        busyActionID = action.id
        actionNote = nil
        actionNoteThread = openThread?.key
        defer { busyActionID = nil }
        do {
            let result = try await model.client.fleetSendAction(id: action.id)
            actionNote = (action.id, SupervisorFormat.deliveryNote(result.delivery, fallback: "Sent."))
            if let fresh = result.state { accept(nextSequence(), fresh) } else { await refresh() }
        } catch let error as DaemonError {
            actionNote = (action.id, SupervisorFormat.failureNote(error))
            if error == .conflict || error == .notFound { await refresh() }
        } catch {
            actionNote = (action.id, .init(text: "Can't reach OpenAGI.", isAlert: true))
        }
    }

    // MARK: - Sections

    private func controls(_ state: FleetState) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            Picker("Mode", selection: Binding(
                get: { FleetMode(rawValue: state.mode ?? "") },
                set: { if let mode = $0 { requestMode(mode) } }
            )) {
                ForEach(FleetMode.allCases, id: \.self) { mode in
                    Text(SupervisorFormat.modeLabel(mode)).tag(Optional(mode))
                }
            }
            .pickerStyle(.segmented)
            .disabled(modeBusy)

            if let hint = SupervisorFormat.modeHint(state.mode) { caption(hint) }
            if let modeNote { NoteLine(note: modeNote) }
            caption(SupervisorFormat.scanLine(lastTickAt: state.lastTickAt, autoScan: state.enabled, now: Date()))
            if let warning = SupervisorFormat.warning(state) {
                Text(warning)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.alert)
                    .lineLimit(1)
            }
            if let scanNote { NoteLine(note: scanNote) }

            HStack(spacing: Theme.Spacing.x3) {
                let isScanning = scanning || state.running
                CompactButton(title: isScanning ? "Scanning…" : "Scan now", filled: false, enabled: !isScanning, stretches: true) {
                    Task { await scan() }
                }
                CompactButton(title: "Ask supervisor", filled: true, stretches: true) { chatOpen = true }
            }
            .padding(.top, Theme.Spacing.x1)
        }
    }

    private func needsYou(_ state: FleetState) -> some View {
        let questions = state.questions.filter { !$0.id.isEmpty }
        let threads = state.snapshot?.threads ?? []
        return VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            sectionTitle("Needs you")
            // An answered question leaves the list; its result still needs saying.
            if let questionNote, !questions.contains(where: { $0.id == questionNote.id }) {
                NoteLine(note: questionNote.note)
            }
            RowGroup {
                if questions.isEmpty {
                    inlineMessage("Nothing needs you.")
                } else {
                    ForEach(Array(questions.enumerated()), id: \.element.id) { index, question in
                        QuestionRow(
                            question: question,
                            threads: threads,
                            busy: busyQuestionID == question.id,
                            anyBusy: busyQuestionID != nil,
                            note: questionNote?.id == question.id ? questionNote?.note : nil,
                            onAnswer: { option in Task { await decide(question, answer: option) } },
                            onDismiss: { Task { await decide(question, answer: nil) } }
                        )
                        if index < questions.count - 1 { RowHairline() }
                    }
                }
            }
        }
    }

    private func threads(_ state: FleetState) -> some View {
        let snapshot = state.snapshot
        let threads = SupervisorFormat.sorted(snapshot?.threads ?? [])
        let proposing = state.mode == FleetMode.propose.rawValue
        return VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            sectionTitle("Threads")
            if snapshot == nil {
                RowGroup { inlineMessage("No scan yet. Tap Scan now.") }
            } else if threads.isEmpty {
                RowGroup { inlineMessage("No recent coding threads.") }
            } else {
                Text(SupervisorFormat.summary(threads))
                    .font(Theme.Typography.secondary)
                    .foregroundStyle(Theme.muted)
                RowGroup {
                    ForEach(Array(threads.enumerated()), id: \.element.key) { index, thread in
                        Button {
                            openThread = thread
                            actionNote = nil
                        } label: {
                            ThreadRow(
                                thread: thread,
                                hasProposal: proposing && !SupervisorFormat.proposed(for: thread, in: state.actions).isEmpty
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Open details")
                        if index < threads.count - 1 { RowHairline() }
                    }
                }
            }
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(Theme.Typography.section)
            .foregroundStyle(Theme.ink)
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.muted)
    }

    private func inlineMessage(_ text: String) -> some View {
        Text(text)
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.gutter)
            .padding(.vertical, 14)
    }
}

// MARK: - Pieces

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

// "Red · Needs you": the colour named in words beside the dot, so colour is
// never the only signal.
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

// A 44-tall button that can sit several to a row: filled `live` for the
// action a person most likely wants, outlined for the rest. PrimaryButton is
// full width by design, which a row of answer options cannot be.
private struct CompactButton: View {
    let title: String
    let filled: Bool
    var enabled = true
    var stretches = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.secondary)
                .lineLimit(2)
                .foregroundStyle(filled ? Color.white : (enabled ? Theme.live : Theme.muted))
                .padding(.horizontal, Theme.Spacing.x4)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
                .frame(maxWidth: stretches ? .infinity : nil)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(filled ? Theme.live.opacity(enabled ? 1 : 0.4) : Color.clear)
                }
                .overlay {
                    if !filled {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Theme.live.opacity(enabled ? 0.5 : 0.2), lineWidth: 1)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

private struct QuestionRow: View {
    let question: FleetQuestion
    let threads: [FleetThread]
    let busy: Bool
    let anyBusy: Bool
    let note: SupervisorFormat.Note?
    let onAnswer: (String) -> Void
    let onDismiss: () -> Void

    private var context: [String] {
        let about: String?
        if let keys = question.threadKeys, keys.count > 1 {
            about = "\(keys.count) threads"
        } else {
            about = question.threadKey.flatMap { key in threads.first(where: { $0.key == key }).map(SupervisorFormat.name) }
        }
        return [about, SupervisorFormat.prNumber(question.prRef), question.createdAt.map { SupervisorFormat.agoPhrase($0) }]
            .compactMap { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Question")
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
            if !context.isEmpty {
                Text(context.joined(separator: " · "))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
            if let body = question.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownContent(blocks: MarkdownParser.parse(body))
            }
            // "dismiss" can arrive as an option; it is the Dismiss button below.
            let options = question.options.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && $0 != "dismiss" }
            FlowLayout(spacing: Theme.Spacing.x2) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    CompactButton(title: option, filled: index == 0, enabled: !anyBusy) { onAnswer(option) }
                }
                Button("Dismiss", action: onDismiss)
                    .font(Theme.Typography.secondary)
                    .foregroundStyle(Theme.muted)
                    .frame(minHeight: 44)
                    .padding(.horizontal, Theme.Spacing.x2)
                    .disabled(anyBusy)
            }
            .padding(.top, Theme.Spacing.x1)
            if busy {
                Text("Sending… an answer can take a few minutes to reach the agent.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
            if let note { NoteLine(note: note) }
            if question.kind == "agent-ask" {
                Text("Your answer goes to the agent.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, 14)
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
        .frame(maxWidth: .infinity, minHeight: Theme.rowMinHeight, alignment: .leading)
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, Theme.Spacing.x3)
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

    @Environment(\.openURL) private var openURL

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
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.x4) {
                VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                    Text(SupervisorFormat.name(thread))
                        .font(Theme.Typography.section)
                        .foregroundStyle(Theme.ink)
                    // Repo and branch are machine identifiers, so mono.
                    if let repo = thread.repo, !repo.isEmpty {
                        Text(repo).font(Theme.Typography.dataMono).foregroundStyle(Theme.muted)
                    }
                    if let branch = thread.branch, !branch.isEmpty {
                        Text(branch).font(Theme.Typography.dataMono).foregroundStyle(Theme.muted)
                    }
                    HStack(spacing: 10) {
                        HealthDot(health: FleetHealth.of(thread))
                        HealthAndState(thread: thread, font: Theme.Typography.secondary)
                    }
                    .padding(.top, Theme.Spacing.x1)
                }

                if !details.isEmpty {
                    RowGroup {
                        ForEach(Array(details.enumerated()), id: \.element.id) { index, detail in
                            detailRow(detail)
                            if index < details.count - 1 { RowHairline() }
                        }
                    }
                }

                if let text = thread.lastAgentText, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Last agent message (unverified)")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.muted)
                        ScrollView {
                            MarkdownContent(blocks: MarkdownParser.parse(text))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                        }
                        .frame(maxHeight: 360)
                        .background(Theme.edge)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }

                ForEach(proposed) { action in
                    VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
                        Text("Proposed nudge")
                            .font(Theme.Typography.section)
                            .foregroundStyle(Theme.ink)
                        if let message = action.message, !message.isEmpty {
                            Text(message).font(Theme.Typography.body).foregroundStyle(Theme.ink)
                        }
                        if let why = [action.detail, action.reason].compactMap({ $0 }).first(where: { !$0.isEmpty }) {
                            Text(why).font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
                        }
                        PrimaryButton(title: "Send", isLoading: busyActionID == action.id) { onSend(action) }
                            .disabled(busyActionID != nil)
                        if let actionNote, actionNote.id == action.id { NoteLine(note: actionNote.note) }
                    }
                }
                // A sent nudge leaves the proposed list; its result still shows.
                if let actionNote, !proposed.contains(where: { $0.id == actionNote.id }) {
                    NoteLine(note: actionNote.note)
                }
            }
            .padding(Theme.gutter)
        }
        .background(Theme.canvas)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
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
