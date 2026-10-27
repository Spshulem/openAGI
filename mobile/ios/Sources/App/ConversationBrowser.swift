import SwiftUI

struct ConversationBrowser: View {
    @Environment(AppModel.self) private var model
    @Binding var thread: ConversationThread
    var onSelect: (UUID?) -> Void
    @State private var search = ""

    var body: some View {
        List {
            if let error = model.conversations.error {
                Section {
                    Text(error).font(.footnote)
                    Button("Retry") { Task { await model.conversations.refresh() } }
                }
            }
            ForEach(ConversationThread.allCases, id: \.self) { kind in
                Section {
                    ForEach(records(kind).filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.preview.localizedCaseInsensitiveContains(search) }, id: \.key) { record in
                        Button {
                            model.conversations.select(record)
                            thread = kind
                            onSelect(nil)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: record.readOnly ? "globe" : kind == .agent ? "bubble.left.and.bubble.right" : "binoculars")
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(record.title).lineLimit(1).foregroundStyle(.primary)
                                    Text(record.preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    if record.readOnly { Text("Web chat").font(.caption2).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                                if thread == kind && model.conversations.selected(kind).conversationID == record.id {
                                    Image(systemName: "checkmark").accessibilityLabel("Selected")
                                }
                            }.padding(.vertical, 4)
                        }
                        .accessibilityIdentifier(record.id == "main" ? "conversation-\(kind.rawValue)" : "conversation-\(kind.rawValue)-\(record.id)")
                    }
                } header: {
                    HStack {
                        Text(kind == .agent ? "Agent" : "Supervisor")
                        Spacer()
                        Button("New chat", systemImage: "square.and.pencil") {
                            Task {
                                if await model.conversations.create(thread: kind) {
                                    thread = kind
                                    onSelect(nil)
                                }
                            }
                        }
                        .labelStyle(.iconOnly)
                        .disabled(model.conversations.isCreating)
                        .accessibilityIdentifier("new-\(kind.rawValue)-chat")
                    }
                }
            }
            if !search.isEmpty {
                Section("Messages in selected chat") {
                    ForEach(model.conversations.selected(thread).messages.filter { $0.text.localizedCaseInsensitiveContains(search) }) { message in
                        Button { onSelect(message.id) } label: {
                            Text(message.text).lineLimit(3).foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Conversations")
        .searchable(text: $search, prompt: "Search conversations")
        .refreshable { await model.conversations.refresh() }
        .task { await model.conversations.refresh() }
        .accessibilityIdentifier("conversation-browser")
    }

    private func records(_ kind: ConversationThread) -> [ConversationSummary] {
        let records = model.conversations.records(for: kind)
        if records.contains(where: { $0.id == "main" }) { return records }
        let chat = kind == .agent ? model.agentChat : model.supervisorChat
        return records + [ConversationSummary(id: "main", thread: kind, title: kind == .agent ? "Shared agent chat" : "Shared supervisor chat",
                                    preview: chat.messages.last?.text ?? "Start a conversation", updatedAt: .distantPast,
                                    messageCount: chat.messages.count, readOnly: false)]
    }
}
