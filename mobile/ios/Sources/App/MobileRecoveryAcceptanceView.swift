#if DEBUG
import SwiftUI
@preconcurrency import AVFoundation
@preconcurrency import Speech

// Explicit developer launch only. Credentials remain in the phone Keychain;
// the receipt records status, never tokens, chat contents or microphone audio.
struct MobileRecoveryAcceptanceView: View {
    struct Report: Codable {
        var createdAt = Date()
        var speechCallbackCompleted = false
        var speechAuthorized = false
        var microphoneGranted = false
        var microphoneStarted = false
        var microphoneError: String?
        var savedPairingFound = false
        var restoredSavedPairing = false
        var connectionError: String?
        var conversationCount: Int?
        var conversationError: String?
        var summaryLoaded = false
        var summaryError: String?
    }

    @State private var report = Report()
    @State private var finished = false
    @State private var dictation = ChatDictation()

    var body: some View {
        NavigationStack {
            Form {
                LabeledContent("Speech callback", value: report.speechCallbackCompleted ? "Completed" : "Checking")
                LabeledContent("Microphone started", value: report.microphoneStarted ? "Passed" : "Not confirmed")
                if let error = report.microphoneError { Text(error) }
                LabeledContent("Saved pairing restored", value: report.restoredSavedPairing ? "Passed" : "Not confirmed")
                if let error = report.connectionError { Text(error) }
                LabeledContent("Conversation count", value: report.conversationCount.map { String($0) } ?? "Unavailable")
                if let error = report.conversationError { Text(error) }
                LabeledContent("Summary", value: report.summaryLoaded ? "Loaded" : "Unavailable")
                if let error = report.summaryError { Text(error) }
                if !finished { ProgressView("Checking this iPhone…") }
            }
            .navigationTitle("Recovery check")
            .task { await run() }
            .onDisappear { dictation.stop() }
        }
    }

    @MainActor private func run() async {
        guard !finished else { return }
        let authorization = await ChatDictation.speechAuthorization()
        report.speechCallbackCompleted = true
        report.speechAuthorized = authorization == .authorized
        report.microphoneGranted = AVAudioApplication.shared.recordPermission == .granted
        if report.speechAuthorized && report.microphoneGranted {
            await dictation.start(draft: "") { _ in }
            report.microphoneStarted = dictation.isListening
            report.microphoneError = dictation.error
            try? await Task.sleep(for: .seconds(2))
            dictation.stop()
        } else {
            report.microphoneError = "Microphone or Speech permission still needs approval on this iPhone."
        }
        save()

        let credential = Credentials.load(from: .server) ?? Credentials.load().flatMap { $0.isEmbedded ? nil : $0 }
        report.savedPairingFound = credential != nil
        if let credential {
            let client = DaemonClient(server: credential.server, nodeID: credential.nodeID, token: credential.token)
            do {
                try await AppSession.shared.switchBackToServer()
                report.restoredSavedPairing = true
                save()
                do { report.conversationCount = try await client.conversations().count }
                catch { report.conversationError = diagnostic(error) }
                save()
                do { _ = try await client.summary(ifNoneMatch: nil); report.summaryLoaded = true }
                catch { report.summaryError = diagnostic(error) }
            } catch { report.connectionError = diagnostic(error) }
        }
        finished = true
        save()
    }

    private func diagnostic(_ error: Error) -> String {
        switch error as? DaemonError {
        case .unauthorized: "saved-enrollment-rejected"
        case .notFound: "server-update-required"
        case .mainConnection(let issue): issue.rawValue
        case .server(let code): "server-http-\(code)"
        case .malformedResponse: "unexpected-server-response"
        case .transport(let error): "network-\((error as NSError).code)"
        default: "connection-check-failed"
        }
    }

    private func save() {
        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("openagi-mobile-recovery.json")
        try? JSONEncoder().encode(report).write(to: output, options: .atomic)
    }
}
#endif
