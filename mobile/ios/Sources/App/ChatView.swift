import SwiftUI

struct ChatMessage: Identifiable, Equatable {
    enum Role: Equatable { case user, assistant }
    let id: UUID
    var role: Role
    var text: String
    var isStreaming: Bool
    var isFailed: Bool = false
    let timestamp: Date

    init(role: Role, text: String, isStreaming: Bool = false, timestamp: Date = Date()) {
        self.id = UUID()
        self.role = role
        self.text = text
        self.isStreaming = isStreaming
        self.timestamp = timestamp
    }
}

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

    @State private var messages: [ChatMessage] = []
    @State private var draft = ""
    @State private var isSending = false
    @State private var isPinnedToBottom = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                GeometryReader { geometry in
                    messageScroll(width: geometry.size.width)
                }
                inputBar
            }
            .background(Theme.canvas)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text("Chat")
                .font(Theme.Typography.screenTitle)
                .foregroundStyle(Theme.ink)
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
                            EmptyStateView(headline: "Say something.",
                                          detail: "OpenAGI reads this the same way it reads everything else you tell it.")
                                .padding(.top, Theme.Spacing.x8)
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
                .scrollDismissesKeyboard(.immediately)

                if !isPinnedToBottom && !messages.isEmpty {
                    jumpToLatestButton(proxy)
                }
            }
        }
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
            MessageBubbleRow(message: item.message, maxContainerWidth: width)
            // DESIGN.md: "A failed send stays in place in `alert` with a
            // 'Try again' directly under it. It is never silently dropped
            // and never a modal."
            if item.message.isFailed {
                Button("Try again") {
                    Task { await retry(item.message) }
                }
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
            TextField("Message OpenAGI", text: $draft, axis: .vertical)
                .font(Theme.Typography.body)
                .lineLimit(1...5)
                .padding(.horizontal, Theme.Spacing.x3)
                .padding(.vertical, Theme.Spacing.x2)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowGroupRadius, style: .continuous))
            Button {
                Task { await send() }
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
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        isSending = true
        defer { isSending = false }

        messages.append(ChatMessage(role: .user, text: text))
        let reply = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(reply)
        isPinnedToBottom = true

        await streamReply(text: text, replyID: reply.id)
    }

    // Re-sends the user message that preceded a failed reply, replacing
    // just that failed bubble in place rather than appending a new one --
    // "stays in place", per DESIGN.md, not a fresh row at the bottom.
    private func retry(_ failedMessage: ChatMessage) async {
        guard let failedIndex = messages.firstIndex(where: { $0.id == failedMessage.id }) else { return }
        guard let userText = messages[..<failedIndex].last(where: { $0.role == .user })?.text else { return }
        let fresh = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages[failedIndex] = fresh
        isPinnedToBottom = true
        await streamReply(text: userText, replyID: fresh.id)
    }

    private func streamReply(text: String, replyID: UUID) async {
        do {
            let stream = try await model.client.sendMessageStreaming(text: text)
            for try await event in stream {
                guard let index = messages.firstIndex(where: { $0.id == replyID }) else { continue }
                switch event {
                case .delta(let frame):
                    if frame.reset {
                        messages[index].text = frame.text
                    } else {
                        messages[index].text += frame.text
                    }
                case .final(let frame):
                    if let reply = frame.reply, !reply.isEmpty {
                        messages[index].text = reply
                    }
                    messages[index].isStreaming = false
                case .failure(let frame):
                    messages[index].text = frame.error ?? "OpenAGI couldn't reply. Try again."
                    messages[index].isStreaming = false
                    messages[index].isFailed = true
                case .status, .session:
                    break
                }
            }
            if let index = messages.firstIndex(where: { $0.id == replyID }) {
                messages[index].isStreaming = false
            }
        } catch let error as DaemonError {
            if let index = messages.firstIndex(where: { $0.id == replyID }) {
                messages[index].text = ChatErrorCopy.message(for: error)
                messages[index].isStreaming = false
                messages[index].isFailed = true
            }
        } catch {
            if let index = messages.firstIndex(where: { $0.id == replyID }) {
                messages[index].text = "Can't reach OpenAGI. Check your connection and try again."
                messages[index].isStreaming = false
                messages[index].isFailed = true
            }
        }
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
