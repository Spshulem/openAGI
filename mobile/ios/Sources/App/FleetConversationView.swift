import SwiftUI

struct FleetConversationView: View {
    @Environment(AppModel.self) private var model
    let thread: FleetThread
    @State private var detail: FleetThreadDetail?
    @State private var loading = false
    @State private var error: String?
    @State private var requestID = UUID()

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Spacing.x5) {
                Text(SupervisorFormat.name(thread))
                    .font(Theme.Typography.section)
                    .foregroundStyle(Theme.ink)
                if let conversation = detail?.conversation {
                    if let reason = conversation.unavailableReason {
                        Text(reason).font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
                    } else if conversation.truncated {
                        Text("Recent conversation · earlier messages may be outside this view.")
                            .font(Theme.Typography.caption).foregroundStyle(Theme.muted)
                    }
                    ForEach(conversation.messages) { message in
                        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
                            HStack {
                                Text(message.role == "user" ? "You" : "Agent")
                                Spacer()
                                if let at = message.at { Text(at, format: .dateTime.month(.abbreviated).day().hour().minute()) }
                            }
                            .font(Theme.Typography.caption).foregroundStyle(Theme.muted)
                            MarkdownContent(blocks: MarkdownParser.parse(message.text))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        RowHairline()
                    }
                    if conversation.messages.isEmpty {
                        Text("No conversation messages were available in the latest read.")
                            .font(Theme.Typography.body).foregroundStyle(Theme.muted)
                    }
                } else if let detail {
                    Text("This host didn’t return conversation history. Run a scan and try again; older servers need an update.")
                        .font(Theme.Typography.secondary).foregroundStyle(Theme.muted)
                    if let message = detail.lastAgentMessage?.text, !message.isEmpty {
                        MarkdownContent(blocks: MarkdownParser.parse(message)).textSelection(.enabled)
                    }
                }
                if loading { ProgressView("Loading conversation…").frame(maxWidth: .infinity) }
                if let error {
                    Text(error).font(Theme.Typography.body).foregroundStyle(Theme.alert)
                    Button("Try again") { Task { await load() } }
                }
            }
            .padding(Theme.gutter)
            .frame(maxWidth: .infinity, alignment: .leading)
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
