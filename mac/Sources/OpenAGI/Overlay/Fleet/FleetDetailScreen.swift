import SwiftUI

/// One "Needs you" question or "In progress" thread, opened from its row:
/// where the chat is, its recent messages, the options, and a reply box.
/// Back returns to the lists.
///
/// Like the rest of the Supervisor tab, nothing that changes this view's
/// height is private @State: the open item, its detail, drafts, in-flight
/// sends and results live on FleetConsumer, which OverlayView watches.
struct FleetDetailScreen: View {
  @ObservedObject var fleet = FleetConsumer.shared
  @ObservedObject var overlay = OverlayState.shared
  @ObservedObject var app = AppState.shared
  let item: FleetOpenItem

  /// The question's words and the thread's lines scroll inside this.
  static let infoHeight: CGFloat = 180

  private var offline: Bool { app.status == .down }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button { fleet.closeItem() } label: {
        Label("Back", systemImage: "chevron.left").font(.system(size: 10))
      }
      .buttonStyle(.borderless)
      .help("Back to Needs you and In progress")

      switch item {
      case let .question(id):
        if let question = fleet.question(id) {
          questionScreen(question)
        } else {
          Text("This question has closed.").font(.system(size: 11)).foregroundStyle(.tertiary)
        }
      case let .thread(key):
        threadScreen(key)
      }
    }
  }

  // MARK: - Question

  @ViewBuilder private func questionScreen(_ question: FleetQuestion) -> some View {
    let busy = fleet.inFlight.contains(question.id) || fleet.stillSending.contains(question.id)
    let options = question.tappableOptions
    let key = question.threadKey
    let detail = key.flatMap { fleet.details[$0] }
    let conversation = detail?.conversation

    if question.risky { FleetRiskyLabel() }
    Text(question.title)
      .font(.system(size: 12, weight: .semibold))
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
    if let place = SupervisorSection.placeLine(question) {
      Text(place).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
    }
    ForEach(Array(question.allChats.prefix(6).enumerated()), id: \.offset) { _, chat in
      FleetOpenChatLine(chat: chat, prefix: question.allChats.count > 1 ? "·" : "In")
    }

    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        if !question.body.isEmpty {
          Text(question.body).font(.system(size: 11)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
        // The ask's own words: always for a risky ask, else when the chat
        // below can't show them.
        if let context = question.displayAskContext, question.risky || (conversation?.messages.isEmpty ?? true) {
          Text("The agent said:").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
          Text(context).font(.system(size: 11))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
        if let key, fleet.thread(key) != nil || detail != nil {
          // An older hub sends no chat: the agent's last words stand in,
          // unless the ask's own words already show.
          FleetThreadLines(summary: FleetThreadSummary(thread: fleet.thread(key), detail: detail),
                           showsExcerpt: conversation == nil && question.displayAskContext == nil)
        }
        if let note = question.reviewNote {
          Text(note).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(3)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxHeight: Self.infoHeight)

    if let key {
      FleetConversationList(conversation: conversation, loading: fleet.detailLoading.contains(key))
    }

    if question.answersInThread {
      let app = (question.openChat ?? question.chats.first)?.appName ?? "the agent's own app"
      Text(options.isEmpty ? "Answer this in \(app)." : "Or answer in \(app).")
        .font(.system(size: 10)).foregroundStyle(.secondary)
    }
    HStack(spacing: 6) {
      if !options.isEmpty {
        FleetOptionButtons(question: question, options: options)
          .disabled(busy || offline)
      }
      Button("Dismiss") { Task { await fleet.dismiss(question) } }
        .buttonStyle(.borderless).font(.system(size: 10))
        .disabled(busy || offline)
        .help("Close this question without answering")
      Button("Chat") { overlay.chatAbout(question) }
        .buttonStyle(.borderless).font(.system(size: 10))
        .help("Chat with the supervisor about this question")
      Spacer(minLength: 0)
      if busy { ProgressView().controlSize(.small) }
    }
    if let note = fleet.notes[question.id] {
      FleetNoteRow(note: note) { fleet.clearNote(question.id) }
    }

    FleetReplyBox(item: item, target: FleetReplyTarget.of(question), risky: question.risky)
  }

  // MARK: - Thread

  @ViewBuilder private func threadScreen(_ key: String) -> some View {
    let thread = fleet.thread(key)
    let detail = fleet.details[key]
    let summary = FleetThreadSummary(thread: thread, detail: detail)
    let conversation = detail?.conversation
    let group = thread?.watch?.group
    let busy = fleet.threadInFlight.contains(key)
    let asks = fleet.questions(about: key)

    Text(thread?.name ?? detail?.title ?? key)
      .font(.system(size: 12, weight: .semibold))
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
    if let chat = thread?.openChat ?? detail?.openChat {
      FleetOpenChatLine(chat: chat)
    }
    if asks.contains(where: \.risky) { FleetRiskyLabel() }

    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        // An older hub sends no chat: the agent's last words stand in.
        FleetThreadLines(summary: summary, showsExcerpt: conversation == nil)
        if group == "push", !summary.muted, let message = summary.pushMessage {
          Text("Push now sends:").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
          Text(message)
            .font(.system(size: 11))
            .fixedSize(horizontal: false, vertical: true)
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxHeight: Self.infoHeight)

    FleetConversationList(conversation: conversation, loading: fleet.detailLoading.contains(key))

    if !asks.isEmpty {
      // Several asks, or a long risky one, scroll: the reply box stays on screen.
      ScrollView {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(asks) { question in
            VStack(alignment: .leading, spacing: 3) {
              FleetQuestionAnswer(question: question)
              Button("Open this question") { fleet.openQuestion(question) }
                .buttonStyle(.borderless).font(.system(size: 10))
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.08)))
          }
        }
        .padding(.trailing, 8)
      }
      .frame(maxHeight: Self.infoHeight)
    }

    HStack(spacing: 8) {
      if group == "push", !summary.muted, summary.pushMessage != nil {
        Button("Push now") { Task { await fleet.pushNow(key) } }
          .controlSize(.small).buttonStyle(.borderedProminent)
          .disabled(busy || offline || thread?.pushing == true)
          .help("Send the supervisor's planned nudge now, as your own message")
      }
      Button(summary.muted ? "Unmute" : "Mute 24h") {
        Task { summary.muted ? await fleet.unmute(key) : await fleet.mute(key) }
      }
      .buttonStyle(.borderless).font(.system(size: 10))
      .disabled(busy || offline)
      .help(summary.muted ? "Watch and nudge this thread again" : "No nudge or question about this thread for a day")
      Button("Fleet page") { AppState.shared.openDashboard(path: "/fleet") }
        .buttonStyle(.borderless).font(.system(size: 10))
      Spacer(minLength: 0)
      if busy { ProgressView().controlSize(.small) }
    }
    if let note = fleet.threadNotes[key] {
      FleetNoteRow(note: note) { fleet.clearThreadNote(key) }
    }

    FleetReplyBox(item: item, target: .of(threadKey: key), risky: false)
  }
}

/// A thread's recent chat, oldest first, in a capped scroll area that opens
/// at the newest message. Plain, selectable text.
struct FleetConversationList: View {
  let conversation: FleetConversation?
  let loading: Bool

  static let maxHeight: CGFloat = 220
  /// The newest messages shown; the rest are on the agent's app.
  static let shownMessages = 40
  /// One message's characters shown; a long one keeps its end.
  static let shownCharacters = 4000

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Text("Recent chat").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        if loading { ProgressView().controlSize(.mini) }
      }
      if let conversation {
        if let reason = conversation.unavailableReason {
          Text(reason).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(3)
        }
        let messages = Self.shown(conversation)
        if messages.isEmpty {
          Text("No messages in the latest read.").font(.system(size: 10)).foregroundStyle(.tertiary)
        } else {
          if conversation.truncated || conversation.messages.count > messages.count {
            Text("Earlier messages are in the agent's app.").font(.system(size: 9)).foregroundStyle(.tertiary)
          }
          ScrollViewReader { proxy in
            ScrollView {
              VStack(alignment: .leading, spacing: 6) {
                ForEach(messages) { message in
                  messageView(message).id(message.id)
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.trailing, 10)
            }
            .frame(maxHeight: Self.maxHeight)
            .onAppear { scrollToEnd(proxy, messages) }
            .onChange(of: messages.last?.id) { _, _ in scrollToEnd(proxy, messages) }
          }
        }
      } else if !loading {
        Text("This hub didn't send the chat. Update it to read the chat here.")
          .font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
      }
    }
  }

  private func messageView(_ message: FleetConversationMessage) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 4) {
        Text(message.speaker).font(.system(size: 10, weight: .semibold))
          .foregroundStyle(message.isOwner ? Color.accentColor : Color.secondary)
        if let at = message.at.flatMap(FleetWatching.parseDate) {
          Text(FleetThreadSummary.ago(at, now: Date())).font(.system(size: 9)).foregroundStyle(.tertiary)
        }
      }
      Text(FleetThreadSummary.tail(message.text, Self.shownCharacters))
        .font(.system(size: 11))
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
  }

  private func scrollToEnd(_ proxy: ScrollViewProxy, _ messages: [FleetConversationMessage]) {
    guard let last = messages.last?.id else { return }
    proxy.scrollTo(last, anchor: .bottom)
  }

  static func shown(_ conversation: FleetConversation) -> [FleetConversationMessage] {
    Array(conversation.messages.suffix(shownMessages))
  }
}

/// The reply box: a few lines that grow as the owner types, Send on ⌘↩.
/// The draft lives on FleetConsumer, so Back keeps it and a failed send
/// never loses it.
struct FleetReplyBox: View {
  @ObservedObject var fleet = FleetConsumer.shared
  @ObservedObject var app = AppState.shared
  let item: FleetOpenItem
  let target: FleetReplyTarget
  /// A risky ask: the hub types the reply into the chat as the owner.
  let risky: Bool

  var body: some View {
    let draft = fleet.drafts[item.key] ?? ""
    let sending = fleet.replyInFlight.contains(item.key)
    let tooLong = FleetReplyTarget.length(draft) > FleetReplyTarget.maxLength
    VStack(alignment: .leading, spacing: 4) {
      switch target {
      case let .none(why):
        Text(why).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
      case .question, .thread:
        TextField("Reply to the agent", text: Binding(
          get: { fleet.drafts[item.key] ?? "" },
          set: { fleet.setDraft($0, for: item) }
        ), axis: .vertical)
        .lineLimit(1...5)
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 11))
        .disabled(sending)
        HStack(spacing: 6) {
          if risky {
            Text("Typed into the chat as you").font(.system(size: 10)).foregroundStyle(.orange)
          }
          if tooLong {
            Text("\(FleetReplyTarget.length(draft))/\(FleetReplyTarget.maxLength)").font(.system(size: 10)).foregroundStyle(.red)
          }
          Spacer(minLength: 0)
          if sending { ProgressView().controlSize(.small) }
          Button("Send") { Task { await fleet.sendReply(item) } }
            .controlSize(.small)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(sending || app.status == .down || FleetReplyTarget.message(draft) == nil)
            .help("Send to the agent (⌘↩)")
        }
      }
      if let note = fleet.replyNotes[item.key] {
        FleetNoteRow(note: note) { fleet.clearReplyNote(item) }
      }
    }
  }
}
