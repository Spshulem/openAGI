import SwiftUI

struct ChatMessage: Identifiable, Equatable {
    enum Role: Equatable { case user, assistant }
    let id: UUID
    var role: Role
    var text: String
    var isStreaming: Bool
    var isFailed: Bool = false

    init(role: Role, text: String, isStreaming: Bool = false) {
        self.id = UUID()
        self.role = role
        self.text = text
        self.isStreaming = isStreaming
    }
}

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

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: Theme.Spacing.x5) {
                            if messages.isEmpty {
                                EmptyStateView(headline: "Say something.",
                                              detail: "OpenAGI reads this the same way it reads everything else you tell it.")
                                    .padding(.top, Theme.Spacing.x8)
                            }
                            ForEach(messages) { message in
                                messageRow(message).id(message.id)
                            }
                        }
                        .padding(Theme.gutter)
                    }
                    .onChange(of: messages.last?.text) { _, _ in
                        if let last = messages.last?.id {
                            withAnimation(nil) { proxy.scrollTo(last, anchor: .bottom) }
                        }
                    }
                    .scrollDismissesKeyboard(.immediately)
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

    private func messageRow(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
            Text(message.role == .user ? "You" : "OpenAGI")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.muted)
            if message.text.isEmpty && message.isStreaming {
                ProgressView().tint(Theme.muted)
            } else {
                Text(message.text)
                    .font(Theme.Typography.body)
                    .foregroundStyle(message.isFailed ? Theme.alert : Theme.ink)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
        messages.append(ChatMessage(role: .assistant, text: "", isStreaming: true))
        let replyIndex = messages.count - 1

        do {
            let stream = try await model.client.sendMessageStreaming(text: text)
            for try await event in stream {
                switch event {
                case .delta(let frame):
                    guard replyIndex < messages.count else { continue }
                    if frame.reset {
                        messages[replyIndex].text = frame.text
                    } else {
                        messages[replyIndex].text += frame.text
                    }
                case .final(let frame):
                    guard replyIndex < messages.count else { continue }
                    if let reply = frame.reply, !reply.isEmpty {
                        messages[replyIndex].text = reply
                    }
                    messages[replyIndex].isStreaming = false
                case .failure(let frame):
                    guard replyIndex < messages.count else { continue }
                    messages[replyIndex].text = frame.error ?? "OpenAGI couldn't reply. Try again."
                    messages[replyIndex].isStreaming = false
                    messages[replyIndex].isFailed = true
                case .status, .session:
                    break
                }
            }
            if replyIndex < messages.count { messages[replyIndex].isStreaming = false }
        } catch {
            if replyIndex < messages.count {
                messages[replyIndex].text = "Can't reach OpenAGI. Check your connection and try again."
                messages[replyIndex].isStreaming = false
                messages[replyIndex].isFailed = true
            }
        }
    }
}
