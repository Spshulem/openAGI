import XCTest
@testable import OpenAGI

// Cross-device queue QA (qa/supervisor-queue/README.md). Skipped unless
// OPENAGI_E2E_HUB is set (xcodebuild: TEST_RUNNER_OPENAGI_E2E_HUB=...): the
// real ChatConversation talks to a real QA hub and writes what this phone
// sees to OPENAGI_E2E_OUT/iphone.jsonl. Synthetic data only.
final class CrossDeviceQueueE2ETests: XCTestCase {
    private struct Env {
        let hub: URL, nodeID: String, token: String, out: URL, t0: Date
    }

    private func env() throws -> Env {
        let values = ProcessInfo.processInfo.environment
        guard let hub = values["OPENAGI_E2E_HUB"].flatMap(URL.init(string:)),
              let nodeID = values["OPENAGI_E2E_PHONE_ID"], let token = values["OPENAGI_E2E_PHONE_TOKEN"],
              let out = values["OPENAGI_E2E_OUT"], let t0 = values["OPENAGI_E2E_T0"].flatMap(Double.init) else {
            throw XCTSkip("Cross-device QA runs only against a QA hub")
        }
        return Env(hub: hub, nodeID: nodeID, token: token, out: URL(fileURLWithPath: out), t0: Date(timeIntervalSince1970: t0 / 1000))
    }

    @MainActor
    private func until(_ date: Date) async throws {
        let wait = date.timeIntervalSinceNow
        if wait > 0 { try await Task.sleep(for: .milliseconds(Int(wait * 1000))) }
    }

    @MainActor
    private func record(_ chat: ChatConversation, _ label: String, to file: URL) {
        let view: [String: Any] = [
            "device": "iphone", "label": label, "at": ISO8601DateFormatter().string(from: Date()),
            "isSending": chat.isSending,
            "hubQueue": chat.hubQueueAvailable,
            "hubRunning": chat.hubRunning?.text ?? NSNull(),
            "queued": chat.queuedSubmissions.map { item -> [String: Any] in
                ["text": item.text, "requestId": item.requestID, "from": item.origin?.sourceName ?? NSNull(),
                 "mine": item.origin?.mine ?? true, "heldBy": item.origin?.heldBy ?? NSNull(),
                 "pending": item.origin?.pendingUpload ?? false, "error": item.origin?.error ?? NSNull(),
                 "sendNow": item.sendNow?.label ?? NSNull()]
            },
            "messages": chat.messages.map { message -> [String: Any] in
                ["role": message.role == .user ? "user" : "assistant", "text": String(message.text.prefix(120)),
                 "requestId": message.requestID ?? NSNull(), "onServer": message.serverID != nil,
                 "failed": message.isFailed, "streaming": message.isStreaming, "detached": message.isDetached]
            }
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: view) else { return }
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile(); handle.write(data); handle.write(Data("\n".utf8)); try? handle.close()
        } else {
            try? (data + Data("\n".utf8)).write(to: file)
        }
    }

    @MainActor
    func testPhoneQueuesTaggedMessagesWhileItsTurnRuns() async throws {
        let env = try env()
        let file = env.out.appending(path: "iphone.jsonl")
        let directory = FileManager.default.temporaryDirectory.appending(path: "e2e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let client = DaemonClient(server: env.hub, nodeID: env.nodeID, token: env.token, session: URLSession(configuration: .ephemeral))
        let chat = ChatConversation(thread: .supervisor, client: client,
                                    store: ChatHistoryStore(thread: "e2e", directory: directory), nodeID: env.nodeID)
        await chat.resume()

        // The harmless running turn, started on this phone before T0.
        try await until(env.t0.addingTimeInterval(-8))
        chat.draft = "[slow] QA running turn from the iPhone"
        XCTAssertTrue(chat.submitDraft())
        record(chat, "running-started", to: file)

        try await until(env.t0)
        chat.draft = "[ios-1] iPhone tagged message one"
        XCTAssertTrue(chat.submitDraft())
        chat.draft = "[ios-2] iPhone tagged message two"
        XCTAssertTrue(chat.submitDraft())
        record(chat, "t0+0", to: file)
        try await until(env.t0.addingTimeInterval(1)); record(chat, "t0+1", to: file)
        try await until(env.t0.addingTimeInterval(5)); await chat.refresh(); record(chat, "t0+5", to: file)

        let deadline = Date().addingTimeInterval(90)
        while (chat.isSending || !chat.queuedSubmissions.isEmpty || chat.hubRunning != nil), Date() < deadline {
            try await Task.sleep(for: .milliseconds(500))
            await chat.refresh()
        }
        await chat.refresh(); record(chat, "settled", to: file)
        try await Task.sleep(for: .seconds(10))
        await chat.refresh(); record(chat, "final", to: file)

        // Phase 2 (hub queue only): edits, removals and Send Now across devices.
        guard chat.hubQueueAvailable else { return }
        let t1 = env.t0.addingTimeInterval(70)
        try await until(t1)
        chat.draft = "[slow] second running turn from the iPhone"
        XCTAssertTrue(chat.submitDraft())
        try await until(t1.addingTimeInterval(3))
        chat.draft = "[ios-6] iPhone message the Mac will send now"
        XCTAssertTrue(chat.submitDraft())
        record(chat, "p2-queued-ios-6", to: file)
        try await until(t1.addingTimeInterval(7)); await chat.refresh()
        if let macThree = chat.queuedSubmissions.first(where: { $0.text.hasPrefix("[mac-3]") }) {
            // The Mac is editing it: this phone must be refused.
            let opened = chat.beginEditingQueued(id: macThree.id)
            if opened { try await Task.sleep(for: .seconds(1)) }
            record(chat, opened ? "p2-edit-mac-3-opened" : "p2-edit-mac-3-refused", to: file)
            if chat.editingQueuedID != nil { chat.cancelQueuedEdit() }
        } else {
            record(chat, "p2-mac-3-missing", to: file)
        }
        try await until(t1.addingTimeInterval(9)); await chat.refresh()
        if let macFour = chat.queuedSubmissions.first(where: { $0.text.hasPrefix("[mac-4]") }) {
            chat.removeQueuedSubmission(id: macFour.id)
        }
        try await Task.sleep(for: .seconds(1)); record(chat, "p2-removed-mac-4", to: file)
        try await until(t1.addingTimeInterval(16)); await chat.refresh(); record(chat, "p2-t1+16", to: file)
        let deadline2 = Date().addingTimeInterval(60)
        while (chat.isSending || !chat.queuedSubmissions.isEmpty || chat.hubRunning != nil), Date() < deadline2 {
            try await Task.sleep(for: .milliseconds(500)); await chat.refresh()
        }
        record(chat, "p2-final", to: file)
        // The app is closed: nothing of this phone runs any more.
        chat.suspend()

        // Phase 3: queue, close the app, let the Mac Send anyway midstream,
        // then reopen and see what the hub ran meanwhile.
        let t2 = env.t0.addingTimeInterval(140)
        let preferences = UserDefaults(suiteName: "e2e-\(UUID().uuidString)")!
        func openApp(_ label: String) async -> ChatConversation {
            let reopened = ChatConversation(thread: .supervisor, client: DaemonClient(server: env.hub, nodeID: env.nodeID, token: env.token,
                                                                                     session: URLSession(configuration: .ephemeral)),
                                            store: ChatHistoryStore(thread: "e2e-\(label)", directory: directory), nodeID: env.nodeID,
                                            preferences: preferences)
            await reopened.resume()
            return reopened
        }
        try await until(t2)
        let session3 = await openApp("p3")
        session3.draft = "[slow] third running turn from the iPhone"
        XCTAssertTrue(session3.submitDraft())
        try await until(t2.addingTimeInterval(3)); await session3.refresh()
        session3.draft = "[ios-7] iPhone queued this, then closed the app"
        XCTAssertTrue(session3.submitDraft())
        try await Task.sleep(for: .seconds(1))
        record(session3, "p3-queued-then-closing", to: file)
        session3.enterBackground()
        session3.suspend()
        try await until(t2.addingTimeInterval(25))
        let session4 = await openApp("p3-reopened")
        record(session4, "p3-reopened", to: file)
        let deadline3 = Date().addingTimeInterval(40)
        while (!session4.queuedSubmissions.isEmpty || session4.hubRunning != nil), Date() < deadline3 {
            try await Task.sleep(for: .milliseconds(500)); await session4.refresh()
        }
        record(session4, "p3-final", to: file)
    }
}
