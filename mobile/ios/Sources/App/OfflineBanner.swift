import SwiftUI

// Today's top row when where the agent runs matters:
// - paired to a Mac that can't be reached, with an offline copy on this
//   iPhone: offer to continue here;
// - using the iPhone agent while a Mac pairing is kept: offer to go back.
struct OfflineBanner: View {
    @Environment(AppModel.self) private var model
    @State private var isWorking = false
    @State private var errorText: String?

    static func isShown(for model: AppModel) -> Bool {
        (!model.isOnPhone && model.refreshFailed && OfflineCopy.shared.hasCopy)
            || (model.isOnPhone && AppSession.shared.serverBackup != nil)
    }

    var body: some View {
        if !model.isOnPhone, model.refreshFailed, OfflineCopy.shared.hasCopy {
            banner(
                title: "Can't reach \(model.hostLabel)",
                detail: "Keep going on this iPhone with your synced chats, memory and skills. What you add here goes to your Mac when it's back.",
                action: "Continue on this iPhone"
            ) {
                model.detach()
                AppSession.shared.continueOnPhone()
            }
        } else if model.isOnPhone, let backup = AppSession.shared.serverBackup {
            banner(
                title: "Using this iPhone",
                detail: errorText ?? "Your Mac (\(backup.server.host ?? "server")) is kept. Switch back to send it what you did here.",
                action: "Switch back to your Mac"
            ) {
                Task { await switchBack() }
            }
        }
    }

    private func banner(title: String, detail: String, action: String, perform: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            Text(title)
                .font(Theme.Typography.body.weight(.semibold))
                .foregroundStyle(Theme.ink)
            Text(detail)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.muted)
            Button(action: perform) {
                if isWorking { ProgressView() } else { Text(action).font(Theme.Typography.body.weight(.medium)) }
            }
            .foregroundStyle(Theme.live)
            .disabled(isWorking)
        }
        .padding(Theme.Spacing.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.rowGroupRadius, style: .continuous))
    }

    private func switchBack() async {
        isWorking = true
        defer { isWorking = false }
        do {
            model.detach()
            _ = try await AppSession.shared.switchBackToServer()
        } catch {
            model.startEventStream()
            errorText = "Can't reach your Mac yet. Your work stays on this iPhone until it can."
        }
    }
}
