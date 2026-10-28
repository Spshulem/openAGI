import AppIntents

// A single native Shortcut/Siri action, sharing the Live Activity's routing
// surface. All replies and approvals still happen in the authenticated app.
struct ReviewAgentSessionsIntent: AppIntent {
    static let title: LocalizedStringResource = "Review agent sessions"
    static let description = IntentDescription("Open the Supervisor to review agents that need you.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        PushRouter.shared.openSupervisor()
        return .result()
    }
}

struct AgentSessionShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ReviewAgentSessionsIntent(), phrases: ["Review agent sessions in \(.applicationName)"],
                    shortTitle: "Review agents", systemImageName: "binoculars")
    }
}
