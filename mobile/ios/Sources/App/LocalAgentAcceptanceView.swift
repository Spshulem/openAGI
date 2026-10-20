#if DEBUG
import SwiftUI

// Explicit developer launch argument, never part of release onboarding.
// Exercises the actual Apple model and embedded daemon on a physical phone,
// preserving the active server credential and restoring the model preference.
struct LocalAgentAcceptanceView: View {
    struct Report: Codable {
        var availability: String
        var modelAnswered = false
        var taskToolWorked = false
        var historyWorked = false
        var error: String?
        var passed: Bool { modelAnswered && taskToolWorked && historyWorked && error == nil }
    }

    @State private var report: Report?

    var body: some View {
        NavigationStack {
            Form {
                if let report {
                    LabeledContent("Apple Intelligence", value: report.availability)
                    LabeledContent("Local model response", value: report.modelAnswered ? "Passed" : "Failed")
                    LabeledContent("Local task tool", value: report.taskToolWorked ? "Passed" : "Failed")
                    LabeledContent("Shared local history", value: report.historyWorked ? "Passed" : "Failed")
                    if let error = report.error { Text(error).foregroundStyle(.red) }
                } else {
                    ProgressView("Checking the local agent…")
                }
            }
            .navigationTitle("Device acceptance")
            .task { await run() }
        }
    }

    @MainActor private func run() async {
        guard report == nil else { return }
        let status = OnDeviceModelStatus.current()
        var result = Report(availability: status.availabilityName)
        var client: DaemonClient?
        var previous: String?
        var createdTaskID: String?
        do {
            guard status == .available else { throw PhoneModelSetup.Failure.unavailable }
            let credential = try await EmbeddedDaemon.shared.localCredentials()
            let local = DaemonClient(server: credential.server, nodeID: credential.nodeID, token: credential.token)
            client = local
            previous = try await local.modelSettings().preference
            await PhoneAgent.connectModel()
            try await PhoneModelSetup.useLocal(client: local, availability: status)
            result.modelAnswered = true
            let marker = "Device acceptance \(UUID().uuidString.prefix(8))"
            let stream = try await local.sendMessageStreaming(
                text: "Add one task to my Today list with exactly this title: \(marker). Use add_task, then confirm.", thread: .agent)
            for try await _ in stream {}
            let tasks = try await local.tasks()
            let created = tasks.first { $0.title.contains(marker) }
            createdTaskID = created?.id
            result.taskToolWorked = created != nil
            let history = try await local.conversationMessages(thread: .agent)
            result.historyWorked = history.messages.contains { $0.text.contains(marker) }
            if !result.taskToolWorked { result.error = "The local model replied but didn't create the requested task." }
        } catch { result.error = error.localizedDescription }
        if let client {
            if let createdTaskID {
                // Remove only this run's synthetic task, never user data.
                _ = try? await EmbeddedDaemon.shared.ownerRaw(path: "/tasks/\(createdTaskID)", method: "DELETE")
            }
            if let previous { _ = try? await client.updateModelSettings(.init(preference: previous)) }
        }
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("openagi-device-acceptance.json")
        try? JSONEncoder().encode(result).write(to: output, options: .atomic)
        report = result
    }
}
#endif
