import SupervisorChannelsKit
import SwiftUI

/// The Supervisor chat's queued messages. Each row: Edit (inline; Save never
/// sends), Send now / Interrupt & send (asks main to stop the running reply,
/// then sends this next) and Remove. The status line is only what main
/// confirmed; an action already running is never described as undone.
///
/// Keyboard: ⌘⇧↩ sends the first queued message now; in the editor ⌘↩
/// saves and Esc cancels (Return adds a line, so editing can never send).
struct SupervisorQueueTray: View {
  @ObservedObject var supervisor: SharedSupervisorClient
  @FocusState private var editorFocused: Bool

  var body: some View {
    let items = supervisor.queuedMessages
    VStack(alignment: .leading, spacing: 6) {
      Text(supervisor.queue.isWaitingOnEdit ? "Queued (\(items.count)) · waiting for your edit" : "Queued (\(items.count))")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(WorkspaceTheme.muted)
        .accessibilityAddTraits(.isHeader)
      if let running = supervisor.hubRunning, running.mine != true {
        Text("Running now from \(running.source?.name ?? "another device"): \(running.text)")
          .font(.caption2)
          .foregroundStyle(WorkspaceTheme.muted)
          .lineLimit(2)
      }
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        if supervisor.queue.editingID == item.id {
          editor(item)
        } else {
          row(item, position: index + 1, of: items.count, isFirst: index == 0)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Queued messages")
  }

  private var sendNowTitle: String { supervisor.isSending ? "Interrupt & send" : "Send now" }

  @ViewBuilder
  private func row(_ item: QueuedSupervisorTurn, position: Int, of total: Int, isFirst: Bool) -> some View {
    let canSendNow = supervisor.canSendQueuedNow(id: item.id)
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Group {
          if item.sendNow == .requesting {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: item.sendNow == nil ? "clock" : "arrow.up.to.line")
          }
        }
        .font(.caption2)
        .foregroundStyle(WorkspaceTheme.live)
        .accessibilityHidden(true)
        Text(item.text)
          .font(WorkspaceTheme.Typography.caption)
          .foregroundStyle(WorkspaceTheme.ink)
          .lineLimit(2)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityLabel("Queued message \(position) of \(total): \(item.text)")
        if !item.payload.attachments.isEmpty {
          Text("\(item.payload.attachments.count) img")
            .font(.caption2)
            .foregroundStyle(WorkspaceTheme.muted)
        }
        Button("Edit") { openEditor(item.id) }
          .buttonStyle(.borderless)
          .font(.caption2.weight(.medium))
          .foregroundStyle(WorkspaceTheme.live)
          .disabled(supervisor.queue.editingID != nil || item.origin?.heldBy != nil)
          .help("Edit this queued message. Saving doesn't send it.")
        sendNowButton(item, enabled: canSendNow, isFirst: isFirst)
        Button { supervisor.removeQueued(id: item.id) } label: {
          Image(systemName: "xmark")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(WorkspaceTheme.muted)
        }
        .buttonStyle(.plain)
        .disabled(item.origin?.heldBy != nil)
        .help("Remove from queue")
        .accessibilityLabel("Remove queued message")
      }
      if let origin = item.origin {
        let notes = [
          origin.mine ? nil : "From \(origin.sourceName ?? "another device")",
          origin.heldBy.map { "Being edited on \($0)" },
          origin.pendingUpload && origin.error == nil ? "Not on main yet; sends when connected" : nil
        ].compactMap { $0 }
        if !notes.isEmpty {
          Text(notes.joined(separator: " · "))
            .font(.caption2)
            .foregroundStyle(WorkspaceTheme.muted)
        }
        if let error = origin.error {
          Text(error)
            .font(.caption2)
            .foregroundStyle(WorkspaceTheme.caution)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let state = item.sendNow {
        Text(state.label)
          .font(.caption2)
          .foregroundStyle(state.isError ? WorkspaceTheme.caution : WorkspaceTheme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(WorkspaceTheme.surfaceFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    // Each control stays its own element for VoiceOver, Voice Control and
    // Full Keyboard Access.
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func sendNowButton(_ item: QueuedSupervisorTurn, enabled: Bool, isFirst: Bool) -> some View {
    let button = Button {
      Task { await supervisor.sendQueuedNow(id: item.id) }
    } label: {
      Label(sendNowTitle, systemImage: "arrow.up.circle.fill")
        .labelStyle(.titleAndIcon)
        .font(.caption2.weight(.semibold))
    }
    .buttonStyle(.borderless)
    .foregroundStyle(enabled ? WorkspaceTheme.live : WorkspaceTheme.muted)
    .disabled(!enabled)
    .help(supervisor.isSending
      ? "Stop the current reply and send this next. An action already running finishes and isn't undone."
      : "Send this next")
    .accessibilityLabel(supervisor.isSending ? "Interrupt reply and send this now" : "Send this next")
    if isFirst {
      button.keyboardShortcut(.return, modifiers: [.command, .shift])
    } else {
      button
    }
  }

  private func editor(_ item: QueuedSupervisorTurn) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      TextField("Queued message", text: $supervisor.queuedEditDraft, axis: .vertical)
        .textFieldStyle(.plain)
        .font(WorkspaceTheme.Typography.caption)
        .lineLimit(1...6)
        .focused($editorFocused)
        .accessibilityLabel("Edit queued message")
      HStack(spacing: 8) {
        Text("The queue waits here until you save. ⌘↩ saves, Esc cancels.")
          .font(.caption2)
          .foregroundStyle(WorkspaceTheme.muted)
        Spacer()
        Button("Cancel") {
          supervisor.cancelQueuedEdit()
          editorFocused = false
        }
        .buttonStyle(.borderless)
        .font(.caption2.weight(.medium))
        .keyboardShortcut(.cancelAction)
        Button("Save") {
          if supervisor.saveQueuedEdit() { editorFocused = false }
        }
        .buttonStyle(.borderedProminent)
        .tint(WorkspaceTheme.live)
        .controlSize(.small)
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(supervisor.queuedEditDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          && item.payload.attachments.isEmpty)
        .help("Save the change. It does not send.")
      }
    }
    .padding(10)
    .background(WorkspaceTheme.surfaceFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(WorkspaceTheme.live.opacity(0.6), lineWidth: 1))
  }

  private func openEditor(_ id: UUID) {
    if supervisor.beginEditingQueued(id: id) { editorFocused = true }
  }
}
