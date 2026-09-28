import SwiftUI

// DESIGN.md's Chat section, added after the first build of this screen put
// a "You"/"OpenAGI" caption above every message and rendered them all
// full-width and left-aligned: "that reads as a log file... Alignment
// carries the speaker... it means no speaker labels at all." Everything
// below follows that section point for point: right/left-aligned bubbles
// with asymmetric corners, tightened/opened spacing by speaker (see
// `MessageGrouping`), Markdown for assistant replies (see `Markdown.swift`),
// a resting three-dot indicator before the first token, a "jump to latest"
// affordance instead of yanking a scrolled-up reader back down, and a
// composer that sits above the keyboard rather than behind it.
//
// mobile/FEATURES.md's Chat tab: "the one that makes the phone genuinely
// useful away from the desk." Sends over `POST /message`, streaming the
// reply as it arrives rather than waiting for the whole answer — see
// ChatEvent's doc comment for why this rides the POST itself rather than
// the shared `GET /events` connection. That shared connection is still what
// the header's dot reflects: "filled while the SSE stream is attached."
struct ChatView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ChatConversationView(conversation: model.agentChat, title: "Chat")
                .navigationBarTitleDisplayMode(.inline)
        }
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
    var showsTitle = true
    var starters: [String] = []
    var placeholder = "Message OpenAGI"
    var emptyDetail = "OpenAGI reads this the same way it reads everything else you tell it."

    @State private var draft = ""
    @State private var isPinnedToBottom = true

    private var messages: [ChatMessage] { conversation.messages }

    var body: some View {
        VStack(spacing: 0) {
            header
            GeometryReader { geometry in
                messageScroll(width: geometry.size.width)
            }
            inputBar
        }
        .background(Theme.canvas)
        .task { await conversation.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await conversation.refresh() } }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            if showsTitle {
                Text(title)
                    .font(Theme.Typography.screenTitle)
                    .foregroundStyle(Theme.ink)
            }
            HStack(spacing: Theme.Spacing.x1) {
                ConnectionDot(state: model.isStreamConnected ? .fresh : .stale)
                Text(model.credentials.server.host ?? "")
                    .font(Theme.Typography.dataMono)
                    .foregroundStyle(Theme.muted)
                Text("·").font(Theme.Typography.caption).foregroundStyle(Theme.muted)
                Text(model.isStreamConnected ? "live" : "reconnecting")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
            // A main from before shared threads: this phone's own copy still
            // shows, but the glasses and other phones can't see it.
            if conversation.historyStatus == .needsUpdate {
                Text("Update OpenAGI on your main to share this chat with your other devices.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, Theme.Spacing.x2)
        .padding(.bottom, Theme.Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func messageScroll(width: CGFloat) -> some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if messages.isEmpty {
                            EmptyStateView(headline: "Say something.", detail: emptyDetail)
                                .padding(.top, Theme.Spacing.x8)
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
                .onChange(of: messages) { _, _ in
                    if isPinnedToBottom { scrollToLatest(proxy) }
                }
                .onAppear { scrollToLatest(proxy) }
                .scrollDismissesKeyboard(.immediately)

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
        Button {
            isPinnedToBottom = true
            scrollToLatest(proxy)
        } label: {
            Text("Jump to latest")
                .font(Theme.Typography.secondary.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, Theme.Spacing.x4)
                .padding(.vertical, Theme.Spacing.x2)
                .background(Theme.live)
                .clipShape(Capsule())
        }
        .padding(.bottom, Theme.Spacing.x3)
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
            // DESIGN.md: "A failed send stays in place in `alert` with a
            // 'Try again' directly under it. It is never silently dropped
            // and never a modal."
            if item.message.isFailed {
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

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: Theme.Spacing.x2) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(Theme.Typography.body)
                .lineLimit(1...5)
                .padding(.horizontal, Theme.Spacing.x3)
                .padding(.vertical, Theme.Spacing.x2)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowGroupRadius, style: .continuous))
            Button {
                let text = draft
                draft = ""
                isPinnedToBottom = true
                Task { await conversation.send(text) }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(canSend ? Theme.live : Theme.muted)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(Theme.gutter)
        .background(Theme.canvas)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversation.isSending
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
              let userText = messages[..<index].last(where: { $0.role == .user })?.text
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
            bubble
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
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
        }
    }

    private var bubble: some View {
        bubbleContent
            .padding(.horizontal, Theme.Spacing.x4)
            .padding(.vertical, Theme.Spacing.x3)
            .frame(
                maxWidth: maxContainerWidth * (message.role == .user ? 0.78 : 0.85),
                alignment: message.role == .user ? .trailing : .leading
            )
            .background(fill)
            .clipShape(bubbleShape)
            .contextMenu {
                Button {
                    UIPasteboard.general.string = message.text
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
    }

    // DESIGN.md: "You: ... `live` at 12% opacity as the bubble fill ...
    // OpenAGI: ... `surface` fill."
    private var fill: Color {
        message.role == .user ? Theme.live.opacity(0.12) : Theme.surface
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
