import SupervisorChannelsKit
import SwiftUI

struct FleetConversationView: View {
    @Environment(AppModel.self) private var model
    let thread: FleetThread
    var fallbackMessages: [SupervisorRecentMessage] = []
    var fallbackSummary: String? = nil
    @State private var detail: FleetThreadDetail?
    @State private var loading = false
    @State private var error: String?
    @State private var requestID = UUID()
    @State private var replyText = ""
    @State private var sendingReply = false
    @State private var sendNote: SupervisorFormat.Note?

    private static func cleanText(_ raw: String) -> String {
        raw
            .replacingOccurrences(
                of: #"<oai-mem-citation\b[\s\S]*?(?:</oai-mem-citation>|$)"#,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            .replacingOccurrences(
                of: #"<(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)\b[\s\S]*?(?:</(?:system_instruction|system-reminder|EXTREMELY_IMPORTANT|TASK_INSTRUCTION)>|$)"#,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func dedupe(_ messages: [FleetConversationMessage]) -> [FleetConversationMessage] {
        var out: [FleetConversationMessage] = []
        var prevRole: String?
        var prevNorm: String?
        for m in messages {
            let cleaned = cleanText(m.text)
            guard !cleaned.isEmpty else { continue }
            let norm = cleaned.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            if prevRole == m.role, prevNorm == norm { continue }
            prevRole = m.role
            prevNorm = norm
            var copy = m
            copy.text = cleaned
            out.append(copy)
        }
        return out
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                messageListContent
            }
            .onAppear {
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
            .onChange(of: detail?.conversation?.messages.count) { _, _ in
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
            .safeAreaInset(edge: .bottom) {
                bottomReplyBar(proxy: proxy)
            }
        }
        .background(Theme.canvas)
        .navigationTitle("Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("supervisor-thread-conversation")
        .refreshable { await load() }
        .task(id: thread.key + model.credentials.server.absoluteString) {
            detail = nil
            await load()
        }
    }

    private var messageListContent: some View {
        LazyVStack(alignment: .leading, spacing: Theme.Spacing.x5) {
            Text(SupervisorFormat.name(thread))
                .font(Theme.Typography.section)
                .foregroundStyle(Theme.ink)
            headerBadges
            transcriptSection
            if loading {
                ProgressView("Loading conversation…").frame(maxWidth: .infinity)
            }
            if let error, fallbackMessages.isEmpty, (fallbackSummary ?? "").isEmpty {
                Text(error).font(Theme.Typography.body).foregroundStyle(Theme.alert)
                Button("Try again") { Task { await load() } }
            }
            Color.clear.frame(height: 1).id("conversation-bottom")
        }
        .padding(Theme.gutter)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var headerBadges: some View {
        if thread.actorLabel != nil || thread.watchdog?.badgeText != nil || thread.nextCheckAt != nil {
            HStack(spacing: 6) {
                if let actor = thread.actorLabel, !actor.isEmpty {
                    BoardActorPill(actor: actor)
                }
                if let wd = thread.watchdog, let wdText = wd.badgeText {
                    Text(wdText)
                        .font(Theme.Typography.caption.weight(wd.isAlert ? .semibold : .regular))
                        .foregroundStyle(wd.isAlert ? Theme.alert : Theme.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background((wd.isAlert ? Theme.alert : Theme.muted).opacity(0.12), in: Capsule())
                } else if let check = SupervisorQuietCheckFormatter.badge(nextCheckDate: thread.nextCheckAt) {
                    BoardQuietCheckPill(label: check)
                }
            }
        }
    }

    @ViewBuilder
    private var transcriptSection: some View {
        if let conversation = detail?.conversation {
            if let reason = conversation.unavailableReason {
                Text(reason).font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
            } else if conversation.truncated {
                Text("Recent conversation · earlier messages may be outside this view.")
                    .font(Theme.Typography.caption).foregroundStyle(Theme.muted)
            }
            let cleanedMessages = Self.dedupe(conversation.messages)
            ForEach(cleanedMessages) { message in
                let actorText = message.actor ?? (message.role == "user" ? "You" : (thread.actorLabel ?? "Agent"))
                turnRow(
                    actor: actorText,
                    isOwner: message.role == "user",
                    text: message.text,
                    at: message.at
                )
            }
            if cleanedMessages.isEmpty {
                Text("No conversation messages were available in the latest read.")
                    .font(Theme.Typography.body).foregroundStyle(Theme.muted)
            }
        } else if !fallbackMessages.isEmpty {
            Text("Saved recent turns from this coding session.")
                .font(Theme.Typography.caption).foregroundStyle(Theme.muted)
            ForEach(fallbackMessages) { message in
                let cleaned = Self.cleanText(message.text)
                if !cleaned.isEmpty {
                    let actorText = message.role == "user" ? "You" : (thread.actorLabel ?? "Agent")
                    turnRow(
                        actor: actorText,
                        isOwner: message.role == "user",
                        text: cleaned,
                        at: message.at
                    )
                }
            }
        } else if let detail {
            Text("This host didn’t return conversation history. Run a scan and try again; older servers need an update.")
                .font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
            if let message = detail.lastAgentMessage?.text {
                let cleaned = Self.cleanText(message)
                if !cleaned.isEmpty {
                    MarkdownContent(blocks: MarkdownParser.parse(cleaned)).textSelection(.enabled)
                }
            }
        } else if let fallbackSummary, error != nil {
            let cleaned = Self.cleanText(fallbackSummary)
            if !cleaned.isEmpty {
                Text("Saved summary from this coding session.")
                    .font(Theme.Typography.caption).foregroundStyle(Theme.muted)
                MarkdownContent(blocks: MarkdownParser.parse(cleaned)).textSelection(.enabled)
            }
        }
    }

    private func turnRow(actor: String, isOwner: Bool, text: String, at: Date?) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            HStack {
                BoardActorPill(actor: actor, isOwner: isOwner)
                Spacer()
                if let at {
                    Text(at, format: .dateTime.month(.abbreviated).day().hour().minute())
                }
            }
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.muted)
            BoardMilestoneStrip(milestones: SupervisorMilestoneParser.parse(from: text))
            MarkdownContent(blocks: MarkdownParser.parse(text))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            RowHairline()
        }
    }

    @ViewBuilder
    private func bottomReplyBar(proxy: ScrollViewProxy) -> some View {
        if !thread.key.hasPrefix("fleet:") {
            let trimmed = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
            VStack(alignment: .leading, spacing: 6) {
                if let sendNote {
                    Text(sendNote.text)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(sendNote.isAlert ? Theme.alert : Theme.muted)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Reply to \(SupervisorFormat.name(thread))…", text: $replyText, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .disabled(sendingReply)
                    Button {
                        Task {
                            await sendReply(trimmed, proxy: proxy)
                        }
                    } label: {
                        Image(systemName: sendingReply ? "hourglass" : "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundStyle(trimmed.isEmpty || sendingReply ? Theme.muted : Theme.live)
                    }
                    .disabled(trimmed.isEmpty || sendingReply)
                    .accessibilityIdentifier("conversation-send-reply")
                }
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
        }
    }

    private func sendReply(_ trimmed: String, proxy: ScrollViewProxy) async {
        guard !trimmed.isEmpty, !sendingReply else { return }
        sendingReply = true
        sendNote = nil
        defer { sendingReply = false }
        do {
            let res = try await model.client.fleetSendMessage(threadKey: thread.key, message: trimmed)
            let note = SupervisorFormat.deliveryNote(res.delivery, fallback: "Sent to coding session.")
            sendNote = note
            if !note.isAlert {
                replyText = ""
                await load()
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
        } catch let err as DaemonError {
            sendNote = SupervisorFormat.failureNote(err)
        } catch {
            sendNote = .init(text: "Couldn't reach OpenAGI.", isAlert: true)
        }
    }

    private func load() async {
        let request = UUID()
        requestID = request
        loading = true; error = nil
        defer { if requestID == request { loading = false } }
        do {
            let fresh = try await model.client.fleetThreadDetail(key: thread.key)
            try Task.checkCancellation()
            guard requestID == request else { return }
            detail = fresh
        } catch is CancellationError {
        } catch let failure as DaemonError {
            guard requestID == request else { return }
            error = failure == .notFound
                ? "This thread is no longer in the connected host’s scan. Refresh Supervisor and open it again."
                : SupervisorFormat.errorCopy(failure).headline
        } catch {
            if requestID == request { self.error = "Couldn’t read this conversation. Check the connection and try again." }
        }
    }
}
