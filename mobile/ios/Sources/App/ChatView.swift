import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// Native SwiftUI navigation, text entry and controls. Conversation state stays
// on AppModel so streaming replies and drafts survive tab and fold changes.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var columns: NavigationSplitViewVisibility = .all
    @State private var compactColumn: NavigationSplitViewColumn = .detail
    @State private var thread: ConversationThread = .agent
    @State private var destination: ChatSheet?
    @State private var selectedMessage: UUID?
    var onClose: (() -> Void)? = nil

    private enum ChatSheet: String, Identifiable {
        case model, settings, fallback, conversations
        var id: String { rawValue }
    }

    private var conversation: ChatConversation {
        model.conversations.selected(thread)
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
            case .conversations:
                NavigationStack {
                    ConversationBrowser(thread: $thread) { message in
                        selectedMessage = message
                        destination = nil
                    }
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { destination = nil } } }
                }
            }
        }
        .task { await model.conversations.refresh() }
    }

    private var conversationSplitView: some View {
        NavigationSplitView(columnVisibility: $columns, preferredCompactColumn: $compactColumn) {
            ConversationBrowser(thread: $thread) { message in
                selectedMessage = message
                compactColumn = .detail
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 320)
        } detail: {
            conversationNavigation
        }
    }

    private var conversationNavigation: some View {
        NavigationStack {
            ChatConversationView(conversation: conversation, title: thread == .agent ? "Chat" : "Supervisor chat",
                                 scrollToMessageID: selectedMessage, onHistorySelectionConsumed: { selectedMessage = nil })
                .id(conversation.identity)
                .toolbar {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button("Conversations", systemImage: "text.bubble") { destination = .conversations }
                            .accessibilityIdentifier("chat-conversations")
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
}

// The conversation screen itself, shared by the Chat tab (thread "agent") and
// the Supervisor tab's "Ask supervisor" (thread "supervisor"): the same
// bubbles and transport, its own title, its own conversation, and a few
// starter questions while it is empty. The conversation lives on AppModel
// (see `ChatConversation`), so this view only draws it.
struct ChatConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.appCanvas) private var canvas
    @Environment(\.chatFont) private var chatFont

    let conversation: ChatConversation
    var title: String
    var scrollToMessageID: UUID? = nil
    var showsTitle = true
    var starters: [String] = []
    var placeholder = "Message OpenAGI"
    var emptyDetail = "OpenAGI reads this the same way it reads everything else you tell it."
    var onComposerFocusChanged: (Bool) -> Void = { _ in }
    var onHistorySelectionConsumed: () -> Void = {}

    @State private var scrollPosition = ScrollPosition(idType: UUID.self)
    @State private var isPinnedToBottom = true
    @State private var hasContentBelow = false
    @State private var isBottomVisible = false
    @State private var userIsScrolling = false
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isPreparingImages = false
    @State private var attachmentError: String?
    @State private var selectedAttachment: ChatAttachment?
    @State private var reviewingApproval: PendingAction?
    @State private var dictation = ChatDictation()
    @FocusState private var composerFocused: Bool
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
        .background(canvas)
        .photosPicker(isPresented: $showingPhotos, selection: $selectedPhotos,
                      maxSelectionCount: max(1, ChatAttachment.maximumCount - conversation.draftAttachments.count), matching: .images)
        .onChange(of: selectedPhotos) { _, photos in
            guard !photos.isEmpty else { return }
            Task { await importPhotos(photos) }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            Task { await importFiles(result) }
        }
        .sheet(item: $selectedAttachment) { attachment in
            NavigationStack {
                ChatAttachmentImage(attachment: attachment, fullSize: true).padding()
                    .navigationTitle(attachment.name).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { selectedAttachment = nil } } }
            }
        }
        .sheet(item: $reviewingApproval) { action in
            NavigationStack {
                ApprovalDetailView(action: action) {
                    model.bumpInboxGeneration()
                    await model.refreshInbox(force: true)
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { reviewingApproval = nil } } }
            }
        }
        .navigationTitle(showsTitle ? title : "")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: composerFocused) { _, focused in
            if focused {
                dictation.stop()
                if isPinnedToBottom || isBottomVisible { scrollToLatest() }
            }
            onComposerFocusChanged(focused)
        }
        .task(id: conversation.identity) { await conversation.refresh() }
        .onDisappear { dictation.stop() }
        .onChange(of: conversation.identity) { _, _ in dictation.stop() }
        .onChange(of: conversation.isSending) { _, sending in
            if !sending {
                Task { await model.conversations.refresh() }
                // A turn can raise an approval; show it under the reply.
                Task { await model.refreshInbox(force: true) }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await conversation.refresh() } }
            else { dictation.stop() }
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
        // Short histories may not scroll far enough to dismiss the keyboard.
        // A normal tap keeps the draft and restores the system navigation.
        .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
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
                    ForEach(raisedApprovals) { action in
                        ChatApprovalCard(action: action) { reviewingApproval = action }
                            .padding(.top, Theme.Spacing.x3)
                    }
                    Color.clear.frame(height: 1)
                        .id(Self.endOfConversation)
                        .onScrollVisibilityChange(threshold: 0.01) { visible in
                            isBottomVisible = visible
                            if visible { isPinnedToBottom = true }
                        }
                }
                .scrollTargetLayout()
                .padding(Theme.gutter)
            }
            .accessibilityIdentifier("chat-history")
            .scrollPosition($scrollPosition)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .onScrollPhaseChange { _, phase in
                userIsScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
            }
            .onScrollGeometryChange(for: ChatScrollGeometry.self) { geometry in
                ChatScrollGeometry(contentHeight: geometry.contentSize.height,
                                   viewportHeight: geometry.containerSize.height,
                                   offset: geometry.contentOffset.y, bottomInset: geometry.contentInsets.bottom)
            } action: { previous, geometry in
                hasContentBelow = !geometry.isAtBottom
                // Keyboard dismissal and fold changes resize the viewport
                // after Send has already moved to the reply. Resolve the
                // message again at that size, rather than retaining a lazy
                // stack's estimated bottom offset.
                if previous.viewportHeight != geometry.viewportHeight && isPinnedToBottom && !userIsScrolling {
                    scrollToLatest()
                }
                // Loading history, streaming and keyboard resizing must
                // not turn a programmatic scroll into 'reading older'.
                // The final bottom update can arrive after the gesture
                // becomes idle, or when a wider layout fits the history.
                if geometry.isAtBottom { isPinnedToBottom = true }
                else if userIsScrolling { isPinnedToBottom = false }
            }
            .onChange(of: raisedApprovals.map(\.id)) { _, ids in
                if !ids.isEmpty && (isPinnedToBottom || isBottomVisible) { scrollToLatest() }
            }
            .onChange(of: messages) { old, new in
                if let first = old.first?.id, first != new.first?.id, old.last?.id == new.last?.id {
                    // Keep the message the reader was looking at in place
                    // when an earlier page is inserted above it.
                    scrollPosition.scrollTo(id: first, anchor: .top)
                } else if isPinnedToBottom || isBottomVisible { scrollToLatest() }
            }
            .onAppear {
                if let id = scrollToMessageID {
                    isPinnedToBottom = false
                    scrollPosition.scrollTo(id: id, anchor: .center)
                    onHistorySelectionConsumed()
                } else { scrollToLatest() }
            }
            .onChange(of: scrollToMessageID) { _, id in
                if let id {
                    isPinnedToBottom = false
                    scrollPosition.scrollTo(id: id, anchor: .center)
                    onHistorySelectionConsumed()
                }
            }
            .scrollDismissesKeyboard(.interactively)

            // A lazy stack's estimated height can still report more
            // content after its actual end has become visible.
            if !isPinnedToBottom && hasContentBelow && !isBottomVisible && !messages.isEmpty {
                jumpToLatestButton()
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

    private func scrollToLatest() {
        withAnimation(nil) {
            if !raisedApprovals.isEmpty {
                // Approval cards follow the newest reply; keep them in view.
                scrollPosition.scrollTo(id: Self.endOfConversation, anchor: .bottom)
            } else if let latest = messages.last?.id {
                // An edge scroll can land in unmaterialized space when the
                // lazy history and keyboard change size in the same turn.
                // A real message ID gives SwiftUI a row to resolve and show.
                scrollPosition.scrollTo(id: latest, anchor: .bottom)
            }
            // Nothing to scroll to yet. An edge scroll here offset the empty
            // chat's centred content by the gutter.
        }
    }

    private func jumpToLatestButton() -> some View {
        let button = Button {
            isPinnedToBottom = true
            scrollToLatest()
        } label: {
            Image(systemName: "arrow.down")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
        }
        .buttonBorderShape(.circle)
        .accessibilityLabel("Jump to latest")
        .accessibilityIdentifier("chat-jump-latest")
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
            if !item.message.attachments.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 8) {
                    ForEach(item.message.attachments) { attachment in
                        Button { selectedAttachment = attachment } label: {
                            ChatAttachmentImage(attachment: attachment)
                                .frame(height: 120).frame(maxWidth: .infinity)
                                .clipShape(.rect(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-message-image")
                    }
                }
                .frame(width: min(width * 0.78, 320))
            }
            MessageBubbleRow(message: item.message, maxContainerWidth: width,
                             showsActions: item.message.id == latestFinishedReplyID)
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

    // Centred, one question and a short list of things to hand off. A tap
    // fills the composer rather than sending, so the owner can add detail.
    // Only the newest finished reply carries Copy and Share under it; older
    // ones keep them in the long-press menu, so the page stays quiet.
    private var latestFinishedReplyID: UUID? {
        guard let last = messages.last, last.role == .assistant, !last.isStreaming, !last.isFailed,
              !last.text.isEmpty else { return nil }
        return last.id
    }

    private static let endOfConversation = UUID()

    // Approvals this conversation raised since your latest message, shown
    // under its reply. Older ones, and other chats', live in the Inbox.
    private var raisedApprovals: [PendingAction] {
        guard let asked = messages.last(where: { $0.role == .user })?.timestamp else { return [] }
        return PendingAction.raised(in: model.workspace.pendingActions ?? [],
                                    thread: conversation.thread,
                                    conversationID: conversation.conversationID,
                                    since: asked,
                                    // A main that predates shared threads runs
                                    // phone chats under other session ids; keep
                                    // showing every recent approval there.
                                    scopedToSession: conversation.historyStatus != .needsUpdate)
    }

    private var chatHome: some View {
        VStack(spacing: Theme.Spacing.x6) {
            VStack(spacing: Theme.Spacing.x2) {
                Image(systemName: "sparkles").font(.title).foregroundStyle(.tint)
                    .frame(width: 56, height: 56)
                    .background(.tint.opacity(0.12), in: .circle)
                    .accessibilityHidden(true)
                Text("What can I take off your plate?")
                    .font(.title2.bold()).multilineTextAlignment(.center)
                Text(model.isOnPhone
                     ? "Your agent, tasks and conversations live on this iPhone."
                     : "Ask for anything. OpenAGI works on it and checks with you before big steps.")
                    .font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            VStack(spacing: Theme.Spacing.x2) {
                ForEach(ChatHomeSuggestion.all) { suggestion in
                    Button { conversation.draft = suggestion.prompt; composerFocused = true } label: {
                        HStack(spacing: Theme.Spacing.x3) {
                            Image(systemName: suggestion.symbol).font(.body).foregroundStyle(.tint)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(suggestion.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                                Text(suggestion.detail).font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(Theme.Spacing.x4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface, in: .rect(cornerRadius: 16, style: .continuous))
                        .contentShape(.rect(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat-suggestion-\(suggestion.id)")
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.vertical, 40)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-home")
    }

    @ViewBuilder
    private var inputBar: some View {
        VStack(spacing: 8) {
            if conversation.isReadOnly {
                Text("Web conversation · Continue in a new chat with its latest 50 messages.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Continue in new chat", systemImage: "square.and.pencil") {
                    Task { await model.conversations.create(thread: conversation.thread, sourceID: conversation.conversationID) }
                }
                .disabled(model.conversations.isCreating)
                .accessibilityIdentifier("chat-continue-web")
                if let error = model.conversations.error { Text(error).font(.footnote).foregroundStyle(.red) }
            } else {
            if !conversation.draftAttachments.isEmpty { attachmentStrip }
            if isPreparingImages { ProgressView("Preparing images…").font(.caption) }
            if let attachmentError {
                Text(attachmentError).font(.footnote).foregroundStyle(.red)
                    .accessibilityIdentifier("chat-attachment-error")
            }
            if let error = dictation.error { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("chat-dictation-error") }
            composerBar
            }
        }
    }

    // One pill holds every control, like Messages: attachments, the field,
    // the microphone and Send. Glass belongs to the pill, not each button.
    @ViewBuilder
    private var composerBar: some View {
        let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
        let pill = composerLayout {
            attachmentMenu.buttonStyle(.plain).foregroundStyle(Theme.muted).frame(width: 44, height: 44)
            composerField
            dictationButton.buttonStyle(.plain).foregroundStyle(dictation.isListening ? Theme.alert : Theme.muted)
                .frame(width: 44, height: 44)
            sendButton.buttonStyle(.plain).frame(width: 44, height: 44)
        }
        .padding(.horizontal, 4).padding(.vertical, 2)
        Group {
            if #available(iOS 26, *) {
                pill.glassEffect(.regular, in: shape)
            } else {
                pill.background(.background.secondary, in: shape)
                    .overlay(shape.strokeBorder(composerFocused ? Theme.live.opacity(0.6) : Theme.edge, lineWidth: 1))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var composerLayout: ComposerLayout {
        ComposerLayout(prefersSeparateControls: dynamicTypeSize >= .xxLarge,
                       rightToLeft: layoutDirection == .rightToLeft)
    }

    private var dictationButton: some View {
        Button {
            if dictation.isListening || dictation.isStarting { dictation.stop() }
            else {
                composerFocused = false
                Task { await dictation.start(draft: conversation.draft) { text in conversation.draft = text } }
            }
        } label: { composerIcon(dictation.isListening ? "stop.fill" : "mic") }
        .accessibilityLabel(dictation.isListening || dictation.isStarting ? "Stop dictation" : "Dictate message")
        .accessibilityValue(dictation.isListening ? "Listening" : "")
        .accessibilityHint("Dictation appears in the message field. Review it before sending.")
        .disabled(conversation.isSending)
        .accessibilityIdentifier("chat-dictation")
    }

    private var attachmentMenu: some View {
        Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { showingPhotos = true }
            Button("Choose Image File", systemImage: "folder") { showingFiles = true }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-attachment-fixture") {
                Button("Attach synthetic image") {
                    Task { await importSyntheticImage() }
                }
            }
            #endif
        } label: { composerIcon("plus") }
        .accessibilityLabel("Add images")
        .menuIndicator(.hidden)
        .accessibilityIdentifier("chat-attach")
        .disabled(isPreparingImages || conversation.draftAttachments.count >= ChatAttachment.maximumCount)
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 12) {
                ForEach(conversation.draftAttachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        ChatAttachmentImage(attachment: attachment)
                            .frame(width: 80, height: 80).clipShape(.rect(cornerRadius: 12))
                            .accessibilityIdentifier("chat-draft-image")
                        Button("Remove image", systemImage: "xmark.circle.fill") {
                            conversation.draftAttachments.removeAll { $0.id == attachment.id }
                        }
                        .labelStyle(.iconOnly).buttonStyle(.bordered).buttonBorderShape(.circle)
                        .accessibilityIdentifier("chat-remove-image")
                    }
                }
            }.padding(.horizontal)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private func appendImages(_ images: [ChatAttachment]) {
        guard conversation.draftAttachments.count + images.count <= ChatAttachment.maximumCount else {
            attachmentError = "Attach up to four images per message."
            return
        }
        conversation.draftAttachments.append(contentsOf: images)
    }

    private func importPhotos(_ photos: [PhotosPickerItem]) async {
        guard !isPreparingImages else { return }
        isPreparingImages = true
        attachmentError = nil
        defer { isPreparingImages = false; selectedPhotos = [] }
        do {
            var prepared: [ChatAttachment] = []
            for photo in photos {
                guard let data = try await photo.loadTransferable(type: Data.self) else { throw ChatAttachmentPreparation.Failure.unreadable }
                prepared.append(try await ChatAttachmentPreparation.prepare(data, name: "Photo.jpg"))
            }
            appendImages(prepared)
        } catch { attachmentError = error.localizedDescription }
    }

    private func importFiles(_ result: Result<[URL], Error>) async {
        guard !isPreparingImages else { return }
        isPreparingImages = true
        attachmentError = nil
        defer { isPreparingImages = false }
        do {
            let urls = try result.get()
            guard urls.count + conversation.draftAttachments.count <= ChatAttachment.maximumCount else {
                attachmentError = "Attach up to four images per message."
                return
            }
            var prepared: [ChatAttachment] = []
            for url in urls { prepared.append(try await ChatAttachmentPreparation.file(url)) }
            appendImages(prepared)
        } catch { attachmentError = error.localizedDescription }
    }

    #if DEBUG
    private func importSyntheticImage() async {
        isPreparingImages = true
        defer { isPreparingImages = false }
        do {
            let data = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQKHgAAAI8AXnXjkfVAAAAAElFTkSuQmCC")!
            appendImages([try await ChatAttachmentPreparation.prepare(data, name: "Synthetic image.png")])
        } catch { attachmentError = error.localizedDescription }
    }
    #endif

    private var composerField: some View {
        @Bindable var conversation = conversation
        return TextField(placeholder, text: $conversation.draft, axis: .vertical)
            .id(conversation.composerRevision)
            .focused($composerFocused)
            .font(chatFont)
            .textFieldStyle(.plain)
            .lineLimit(1...(dynamicTypeSize.isAccessibilitySize ? 3 : 5))
            .submitLabel(.send)
            .onSubmit { sendDraft() }
            .padding(.horizontal, 6).padding(.vertical, 10)
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 44)
            .accessibilityLabel(placeholder)
            .accessibilityIdentifier("chat-composer")
    }

    private var sendButton: some View {
        Button(action: sendDraft) {
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(canSend ? Color(uiColor: .systemBackground) : Theme.muted)
                .frame(width: 32, height: 32)
                .background(canSend ? Theme.ink : Theme.muted.opacity(0.2), in: .circle)
                .frame(width: 44, height: 44)
                .contentShape(.circle)
        }
            .accessibilityLabel("Send")
            .disabled(!canSend)
            .accessibilityIdentifier("chat-send")
    }

    private func composerIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 18, weight: .medium))
            // Plain buttons take their label's size: the label itself is
            // the 44-point touch target.
            .frame(width: 44, height: 44)
            .contentShape(.rect)
    }

    private func sendDraft() {
        guard canSend else { return }
        dictation.stop()
        if conversation.submitDraft() { isPinnedToBottom = true }
    }

    private var canSend: Bool {
        conversation.canSubmitDraft && !isPreparingImages
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
    static func target(failedID: UUID, in messages: [ChatMessage], isSending: Bool) -> (index: Int, userText: String, attachments: [ChatAttachment])? {
        guard !isSending,
              let index = messages.firstIndex(where: { $0.id == failedID }),
              messages[index].isFailed && messages[index].retrySafe,
              let user = messages[..<index].last(where: { $0.role == .user }),
              user.attachments.allSatisfy({ $0.data != nil })
        else { return nil }
        return (index, user.text, user.attachments)
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
        case .imagesUnsupported:
            return "Update OpenAGI on your main server to send images. The images were not sent without their content."
        case .agentHostDisabled:
            return "OpenAGI can't reply -- no agent host is configured on this daemon. Open its dashboard and finish setup, then try again."
        case .unauthorized:
            return "The server didn't authorize this chat. Your saved connection was kept. Check the enrollment and server version in Connection Settings."
        case .mainConnection(let issue):
            return issue.message
        case .notFound:
            return "This chat feature isn't available on the server. Check its OpenAGI version, then refresh. Your saved connection was kept."
        case .conflict:
            return "The server couldn't accept this turn yet. Refresh the conversation before sending again."
        case .server(let status):
            return "The server returned error \(status). Check the conversation before sending again."
        case .malformedResponse:
            return "The server returned an unexpected chat response. Check its OpenAGI version, then refresh the conversation."
        case .unreachableHost, .transport:
            return "Couldn't confirm delivery. Check your connection and refresh the conversation before sending again."
        }
    }
}

// One row. Your lines sit in a compact bubble on the trailing side; a reply
// is plain text on the page, full width, like a document. While a reply
// streams, a working line says what the agent is doing. A failed reply is
// plain `alert` text (the app's own copy, never run through Markdown).
private struct MessageBubbleRow: View {
    @Environment(\.chatFont) private var chatFont
    let message: ChatMessage
    let maxContainerWidth: CGFloat
    var showsActions = false

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: Theme.Spacing.x8)
                IntrinsicBubbleLayout(maxWidth: max(0, maxContainerWidth - 2 * Theme.gutter) * 0.78) {
                    userBubble
                }
            }
        } else {
            reply
        }
    }

    private var userBubble: some View {
        Text(message.text)
            .font(chatFont)
            .foregroundStyle(Theme.ink)
            .textSelection(.enabled)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Theme.Spacing.x4)
            .padding(.vertical, Theme.Spacing.x3)
            .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: 20, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-bubble-user")
            .contextMenu { copyButton }
    }

    private var reply: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            if message.isFailed {
                Text(message.text)
                    .font(chatFont)
                    .foregroundStyle(Theme.alert)
            } else if !message.text.isEmpty {
                MarkdownContent(blocks: MarkdownParser.parse(message.text))
            }
            if message.isStreaming {
                ChatWorkingLine(text: message.activity ?? "Thinking")
            }
            if showsActions { actions }
        }
        .lineLimit(nil)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-bubble-assistant")
        .contextMenu { copyButton }
    }

    // Copy and Share under the newest reply.
    private var actions: some View {
        HStack(spacing: Theme.Spacing.x1) {
            Button {
                UIPasteboard.general.string = message.text
            } label: {
                Image(systemName: "doc.on.doc").frame(width: 36, height: 36)
            }
            .accessibilityLabel("Copy reply")
            .accessibilityIdentifier("chat-reply-copy")
            ShareLink(item: message.text) {
                Image(systemName: "square.and.arrow.up").frame(width: 36, height: 36)
            }
            .accessibilityLabel("Share reply")
            .accessibilityIdentifier("chat-reply-share")
        }
        .font(.subheadline)
        .foregroundStyle(Theme.muted)
        .buttonStyle(.plain)
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = message.text
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
    }
}

// What the agent is doing right now, under a streaming reply: "Thinking",
// "Using fleet status". Replaces the old three-dot indicator, which said
// nothing about progress on a long, tool-heavy turn.
struct ChatWorkingLine: View {
    let text: String

    var body: some View {
        HStack(spacing: Theme.Spacing.x2) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("OpenAGI is working: \(text)")
        .accessibilityIdentifier("chat-working")
    }
}

// An approval the agent raised, inline in the conversation: what it wants to
// do and why. Review opens the same detail the Inbox uses, where Approve and
// Deny live with their full result handling.
struct ChatApprovalCard: View {
    let action: PendingAction
    let onReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            Text("NEEDS YOUR OK")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tint)
            Text(action.summary)
                .font(.headline)
                .foregroundStyle(Theme.ink)
            if let reason = action.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
                Text(reason)
                    .font(Theme.Typography.secondary)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(4)
            }
            Button("Review", action: onReview)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .padding(.top, Theme.Spacing.x1)
                .accessibilityIdentifier("chat-approval-review-\(action.id)")
        }
        .padding(Theme.Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: .rect(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-approval-\(action.id)")
    }
}

// The empty chat's starting points. Each fills the composer.
struct ChatHomeSuggestion: Identifiable {
    let id: String
    let symbol: String
    let title: String
    let detail: String
    let prompt: String

    static let all = [
        ChatHomeSuggestion(id: "plan", symbol: "sun.max", title: "Plan my day",
                           detail: "What matters today, in order", prompt: "Help me plan my day"),
        ChatHomeSuggestion(id: "tasks", symbol: "checklist", title: "Show my tasks",
                           detail: "Open, overdue and coming up", prompt: "Show my tasks"),
        ChatHomeSuggestion(id: "remember", symbol: "brain", title: "Remember something",
                           detail: "A fact, a preference, a promise", prompt: "Remember something for me")
    ]
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


struct ChatScrollGeometry: Equatable {
    let contentHeight: CGFloat
    let viewportHeight: CGFloat
    let offset: CGFloat
    let bottomInset: CGFloat

    var isAtBottom: Bool {
        let maximumOffset = max(0, contentHeight + bottomInset - viewportHeight)
        // Bottom alignment and rubber-banding can produce negative offsets
        // even when the entire conversation fits in the visible viewport.
        return maximumOffset == 0 || offset >= maximumOffset - 60
    }
}
