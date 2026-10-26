import SwiftUI

// Native SwiftUI navigation, text entry and controls. Conversation state stays
// on AppModel so streaming replies and drafts survive tab and fold changes.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var columns: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .detail
    @State private var thread: ConversationThread = .agent
    @State private var search = ""
    @State private var destination: ChatSheet?
    @State private var selectedMessage: UUID?
    var onClose: (() -> Void)? = nil

    private enum ChatSheet: String, Identifiable {
        case model, settings, fallback
        var id: String { rawValue }
    }

    private var conversation: ChatConversation {
        thread == .agent ? model.agentChat : model.supervisorChat
    }

    var body: some View {
        Group {
            if onClose != nil {
                // A supporting pane already shares the workspace's width.
                // A nested split view can cover its detail and Close button.
                conversationNavigation
            } else {
                conversationSplitView
            }
        }
        .sheet(item: $destination) { sheet in
            switch sheet {
            case .model:
                NavigationStack {
                    ModelSettingsView()
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { destination = nil } } }
                }
            case .settings: SettingsView(onRevoked: { AppSession.shared.revoked() })
            case .fallback: FallbackChatView()
            }
        }
    }

    private var conversationSplitView: some View {
        NavigationSplitView(columnVisibility: $columns, preferredCompactColumn: $compactColumn) {
            List {
                Section("Your conversations") {
                    conversationRow("Agent", symbol: "bubble.left.and.bubble.right", chat: model.agentChat, thread: .agent)
                    conversationRow("Supervisor", symbol: "binoculars", chat: model.supervisorChat, thread: .supervisor)
                }
                if !search.isEmpty {
                    Section("Messages") {
                        ForEach(conversation.messages.filter { $0.text.localizedCaseInsensitiveContains(search) }, id: \.id) { message in
                            Button {
                                selectedMessage = message.id
                                compactColumn = .detail
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(message.role == .user ? "You" : "OpenAGI").font(.caption).foregroundStyle(.secondary)
                                    Text(message.text).lineLimit(3).foregroundStyle(.primary)
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $search, prompt: "Search saved messages")
            .navigationTitle("Conversations")
            .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 320)
        } detail: {
            conversationNavigation
        }
    }

    private var conversationNavigation: some View {
        NavigationStack {
            ChatConversationView(conversation: conversation, title: thread == .agent ? "Chat" : "Supervisor chat",
                                 scrollToMessageID: selectedMessage)
                .toolbar {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button("Model", systemImage: "cpu") { destination = .model }
                            .accessibilityIdentifier("chat-model")
                        Menu {
                            if onClose != nil {
                                Picker("Conversation", selection: $thread) {
                                    Text("Agent").tag(ConversationThread.agent)
                                    Text("Supervisor").tag(ConversationThread.supervisor)
                                }
                            }
                            Button("Settings", systemImage: "gearshape") { destination = .settings }
                            if !model.isOnPhone {
                                Button("Chat without server", systemImage: "network.slash") { destination = .fallback }
                            }
                        } label: { Label("Chat options", systemImage: "ellipsis") }
                        if let onClose {
                            Button("Close chat", systemImage: "xmark", action: onClose)
                                .accessibilityIdentifier("close-chat-pane")
                        }
                    }
                }
        }
    }

    private func conversationRow(_ title: String, symbol: String, chat: ChatConversation, thread target: ConversationThread) -> some View {
        Button {
            thread = target
            selectedMessage = nil
            compactColumn = .detail
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol).frame(width: 22)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.body.weight(.medium)).foregroundStyle(.primary)
                    Text(chat.messages.last?.text ?? "Start a conversation")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if thread == target { Image(systemName: "checkmark").accessibilityLabel("Selected") }
            }.padding(.vertical, 4)
        }
        .accessibilityIdentifier("conversation-\(target.rawValue)")
    }
}

// The conversation screen itself, shared by the Chat tab (thread "agent") and
// the Supervisor tab's "Ask supervisor" (thread "supervisor"): the same
// bubbles and transport, its own title, its own conversation, and a few
// starter questions while it is empty. The conversation lives on AppModel
// (see `ChatConversation`), so this view only draws it.
struct ChatConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    let conversation: ChatConversation
    var title: String
    var scrollToMessageID: UUID? = nil
    var showsTitle = true
    var starters: [String] = []
    var placeholder = "Message OpenAGI"
    var emptyDetail = "OpenAGI reads this the same way it reads everything else you tell it."
    var onComposerFocusChanged: (Bool) -> Void = { _ in }

    @State private var isPinnedToBottom = true
    @FocusState private var composerFocused: Bool
    @Environment(\.layoutDirection) private var layoutDirection

    private var messages: [ChatMessage] { conversation.messages }

    var body: some View {
        GeometryReader { geometry in
            // Keep the composer below history in every pose. An overlay
            // arrangement can put it behind the message scroll view, where
            // it is visible but cannot receive taps or keyboard focus.
            ConversationLayout(division: DuoLayout.division(in: geometry, layoutDirection: layoutDirection),
                               rightToLeft: layoutDirection == .rightToLeft) {
                conversationContent
                inputBar
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle(showsTitle ? title : "")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: composerFocused) { _, focused in onComposerFocusChanged(focused) }
        .task(id: conversation.thread) { await conversation.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await conversation.refresh() } }
        }
    }

    private var conversationContent: some View {
        VStack(spacing: 0) {
            header
            GeometryReader { geometry in
                messageScroll(width: geometry.size.width)
            }
        }
        .frame(maxWidth: 600)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var header: some View {
        if conversation.historyStatus == .needsUpdate {
            Label("Update OpenAGI on your main to share this chat with your other devices.", systemImage: "arrow.down.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding()
        } else if conversation.historyStatus == .offline || conversation.historyStatus == .needsPairing {
            VStack(alignment: .leading, spacing: 8) {
                Label(conversation.historyStatus == .needsPairing
                      ? "Connect to your main again in Settings to load chat history."
                      : "Couldn't load chat history. Saved messages are still available.",
                      systemImage: "exclamationmark.bubble")
                Button("Retry") { Task { await conversation.refresh() } }
                    .disabled(conversation.isRefreshingHistory)
            }
            .font(.footnote)
            .padding()
        }
    }

    private func messageScroll(width: CGFloat) -> some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if conversation.nextBefore != nil {
                            VStack(spacing: 8) {
                                Button("Load earlier messages") {
                                    Task { await conversation.loadOlder() }
                                }
                                .disabled(conversation.isLoadingOlder)
                                if conversation.isLoadingOlder { ProgressView("Loading earlier messages…") }
                                if let error = conversation.olderHistoryError {
                                    Text(error).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.bottom)
                        }
                        if messages.isEmpty && conversation.historyStatus == .unknown {
                            ProgressView("Loading chat history…")
                                .frame(maxWidth: .infinity)
                                .padding(.top, Theme.Spacing.x8)
                        } else if messages.isEmpty && (conversation.historyStatus == .synced || conversation.historyStatus == .needsUpdate) {
                            chatHome
                            if !starters.isEmpty { starterButtons }
                        }
                        ForEach(MessageGrouping.displayItems(for: messages), id: \.message.id) { item in
                            messageItemView(item, width: width)
                        }
                    }
                    .padding(Theme.gutter)
                }
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 60
                } action: { _, atBottom in
                    isPinnedToBottom = atBottom
                }
                .onChange(of: messages) { old, new in
                    if let first = old.first?.id, first != new.first?.id, old.last?.id == new.last?.id {
                        // Keep the message the reader was looking at in place
                        // when an earlier page is inserted above it.
                        proxy.scrollTo(first, anchor: .top)
                    } else if isPinnedToBottom { scrollToLatest(proxy) }
                }
                .onAppear { scrollToLatest(proxy) }
                .onChange(of: scrollToMessageID) { _, id in
                    if let id {
                        isPinnedToBottom = false
                        proxy.scrollTo(id, anchor: .center)
                    }
                }
                .scrollDismissesKeyboard(.interactively)

                if !isPinnedToBottom && !messages.isEmpty {
                    jumpToLatestButton(proxy)
                }
            }
        }
    }

    private var starterButtons: some View {
        VStack(spacing: Theme.Spacing.x2) {
            ForEach(starters, id: \.self) { starter in
                Button {
                    Task { await conversation.send(starter) }
                } label: {
                    Text(starter)
                        .font(Theme.Typography.secondary)
                        .foregroundStyle(Theme.live)
                        .padding(.horizontal, Theme.Spacing.x4)
                        .padding(.vertical, Theme.Spacing.x2)
                        .overlay(Capsule().strokeBorder(Theme.live.opacity(0.5), lineWidth: 1))
                }
                .disabled(conversation.isSending)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        guard let last = messages.last?.id else { return }
        withAnimation(nil) { proxy.scrollTo(last, anchor: .bottom) }
    }

    private func jumpToLatestButton(_ proxy: ScrollViewProxy) -> some View {
        let button = Button {
            isPinnedToBottom = true
            scrollToLatest(proxy)
        } label: {
            Image(systemName: "arrow.down")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
        }
        .buttonBorderShape(.circle)
        .accessibilityLabel("Jump to latest")
        .padding(.bottom, Theme.Spacing.x3)
        return Group {
            if #available(iOS 26.0, *) { button.buttonStyle(.glass) }
            else { button.buttonStyle(.bordered) }
        }
    }

    // DESIGN.md: "Consecutive messages from the same speaker tighten to 2pt
    // apart; a change of speaker opens to 12... a centred `caption` in
    // `muted` between the two groups" for a >15-minute gap.
    private func messageItemView(_ item: MessageGrouping.DisplayItem, width: CGFloat) -> some View {
        let isUser = item.message.role == .user
        return VStack(alignment: isUser ? .trailing : .leading, spacing: Theme.Spacing.x1) {
            if let dividerText = item.timestampDividerText {
                Text(dividerText)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            // A shared thread: a question asked on the glasses or another
            // phone says where it came from. Lines from this phone don't.
            if isUser, let source = ChatSourceLabel.text(for: item.message, ownNodeID: model.credentials.nodeID) {
                Text(source)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
            MessageBubbleRow(message: item.message, maxContainerWidth: width)
            // Offer a resend only when the daemon rejected the turn before
            // it ran. A lost stream can hide a completed action.
            if item.message.isFailed && item.message.retrySafe {
                Button("Try again") {
                    Task { await conversation.retry(item.message) }
                }
                .disabled(conversation.isSending)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.alert)
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .padding(.top, item.spacingBefore)
        .id(item.message.id)
    }

    private var chatHome: some View {
        VStack(alignment: .leading, spacing: 20) {
            Image(systemName: "sparkle").font(.largeTitle).foregroundStyle(.tint)
            Text("What would you like to do?").font(.largeTitle.bold())
            Text(model.isOnPhone
                 ? "Your agent, tasks and conversations live on this iPhone."
                 : "Plan your day, keep track of work, or ask your agent for help.")
                .foregroundStyle(.secondary)
            ForEach(["Help me plan my day", "Show my tasks", "Remember something for me"], id: \.self) { prompt in
                Button { conversation.draft = prompt; composerFocused = true } label: {
                    Label(prompt, systemImage: "arrow.up.left")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.bordered).controlSize(.large)
            }
        }
        .padding(.vertical, 40)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("chat-home")
    }

    @ViewBuilder
    private var inputBar: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: 12) {
                HStack(alignment: .bottom, spacing: 12) {
                    composerField
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .glassEffect(.regular, in: .capsule)
                    sendButton
                        .buttonStyle(.glassProminent)
                        .buttonBorderShape(.circle)
                        .controlSize(.large)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        } else {
            HStack(alignment: .bottom, spacing: 12) {
                composerField.textFieldStyle(.roundedBorder)
                sendButton.buttonStyle(.borderedProminent).buttonBorderShape(.circle)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    private var composerField: some View {
        @Bindable var conversation = conversation
        return TextField(placeholder, text: $conversation.draft, axis: .vertical)
            .focused($composerFocused)
            .font(.body)
            .lineLimit(1...5)
            .submitLabel(.send)
            .onSubmit { sendDraft() }
            .accessibilityLabel(placeholder)
            .accessibilityIdentifier("chat-composer")
    }

    private var sendButton: some View {
        Button("Send", systemImage: "arrow.up", action: sendDraft)
            .labelStyle(.iconOnly)
            .disabled(!canSend)
            .accessibilityIdentifier("chat-send")
    }

    private func sendDraft() {
        guard canSend else { return }
        let text = conversation.draft
        conversation.draft = ""
        isPinnedToBottom = true
        Task { await conversation.send(text) }
    }

    private var canSend: Bool {
        !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversation.isSending
    }
}

// "From Spencer's G2" above a user line another device sent into the shared
// thread. Nothing for this phone's own lines, or for lines whose source the
// daemon did not record.
enum ChatSourceLabel {
    static func text(for message: ChatMessage, ownNodeID: String) -> String? {
        guard message.role == .user, let sourceNodeId = message.sourceNodeId, sourceNodeId != ownNodeID else { return nil }
        let name = message.sourceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "From another device" : "From \(name)"
    }
}

// Which failed reply a "Try again" tap re-sends, and with what text -- or nil
// when it must not run. Retries used to skip `isSending`, so repeated taps, or
// a retry racing the composer, fired concurrent `POST /message` calls for the
// same node session: duplicated user turns, repeated tool side effects, and
// two streams writing one bubble. Now they share `send()`'s single-flight gate.
enum ChatRetry {
    static func target(failedID: UUID, in messages: [ChatMessage], isSending: Bool) -> (index: Int, userText: String)? {
        guard !isSending,
              let index = messages.firstIndex(where: { $0.id == failedID }),
              messages[index].isFailed && messages[index].retrySafe,              let userText = messages[..<index].last(where: { $0.role == .user })?.text
        else { return nil }
        return (index, userText)
    }
}

// DESIGN.md's copy rules ("Never: ... an error that does not say what to do
// next") applied to the one chat-specific failure this daemon has: no model
// provider configured yet. `.agentHostDisabled` gets its own legible line
// instead of falling into the generic "can't reach" copy that used to be
// indistinguishable from an actually-down daemon.
enum ChatErrorCopy {
    static func message(for error: DaemonError) -> String {
        switch error {
        case .agentHostDisabled:
            return "OpenAGI can't reply -- no agent host is configured on this daemon. Open its dashboard and finish setup, then try again."
        case .unauthorized:
            return "Needs re-pairing -- revoke and pair again in Settings."
        case .mainConnection(let issue):
            return issue.message
        case .notFound, .conflict, .malformedResponse, .server, .unreachableHost, .transport:
            return "Can't reach OpenAGI. Check your connection and try again."
        }
    }
}

// One row: the bubble, aligned and filled per speaker, sized to DESIGN.md's
// max-width fractions of the available width. A resting three-dot
// indicator stands in before the first token arrives; a failed reply
// renders as plain `alert` text (it's the app's own copy, not model
// content, so it is never run through the Markdown renderer).
private struct MessageBubbleRow: View {
    let message: ChatMessage
    let maxContainerWidth: CGFloat

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: Theme.Spacing.x8) }
            IntrinsicBubbleLayout(maxWidth: max(0, maxContainerWidth - 2 * Theme.gutter) * (message.role == .user ? 0.78 : 0.92)) {
                bubble
            }
            if message.role == .assistant { Spacer(minLength: Theme.Spacing.x8) }
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        if message.isFailed {
            Text(message.text)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.alert)
        } else if message.text.isEmpty && message.isStreaming {
            TypingIndicatorView()
        } else if message.role == .assistant {
            MarkdownContent(blocks: MarkdownParser.parse(message.text))
        } else {
            Text(message.text)
                .font(.body)
                .foregroundStyle(.white)
                .textSelection(.enabled)
        }
    }

    private var bubble: some View {
        bubbleContent
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Theme.Spacing.x4)
            .padding(.vertical, Theme.Spacing.x3)
            .background(fill)
            .clipShape(bubbleShape)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-bubble-\(message.role == .user ? "user" : "assistant")")
            .contextMenu {
                Button {
                    UIPasteboard.general.string = message.text
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
    }

    // Messages remain in the content layer; glass belongs to the controls.
    private var fill: Color {
        message.role == .user ? .accentColor : .clear
    }

    // DESIGN.md: "radius 18 with the bottom-trailing corner at 4" (you) /
    // "bottom-leading corner at 4" (OpenAGI).
    private var bubbleShape: UnevenRoundedRectangle {
        message.role == .user
            ? UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 4, topTrailingRadius: 18, style: .continuous)
            : UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 4, bottomTrailingRadius: 18, topTrailingRadius: 18, style: .continuous)
    }
}

// DESIGN.md: "Before the first token, show a three-dot resting indicator
// inside an assistant bubble -- not a full-screen spinner." Deliberately
// static: the Motion section reserves this app's one animation for task
// completion, and everything else -- explicitly including "no shimmer, no
// pulsing dot" -- stays still.
private struct TypingIndicatorView: View {
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.muted).frame(width: 6, height: 6)
            Circle().fill(Theme.muted.opacity(0.7)).frame(width: 6, height: 6)
            Circle().fill(Theme.muted.opacity(0.4)).frame(width: 6, height: 6)
        }
        .accessibilityLabel("OpenAGI is typing")
    }
}

// Measure short replies at their natural width, then cap longer content at
// the available column width. A maxWidth frame around Text can stretch a
// one-word reply on an expanded display.
private struct IntrinsicBubbleLayout: Layout {
    var maxWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let width = min(maxWidth, proposal.width ?? maxWidth, content.sizeThatFits(.unspecified).width)
        let size = content.sizeThatFits(.init(width: width, height: nil))
        return CGSize(width: width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
                             proposal: .init(width: bounds.width, height: bounds.height))
    }
}
