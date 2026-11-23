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
            "queued": chat.queuedSubmissions.map { ["text": $0.text, "requestId": $0.requestID] },
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
        while (chat.isSending || !chat.queuedSubmissions.isEmpty), Date() < deadline {
            try await Task.sleep(for: .milliseconds(250))
        }
        await chat.refresh(); record(chat, "settled", to: file)
        try await Task.sleep(for: .seconds(10))
        await chat.refresh(); record(chat, "final", to: file)
    }
}
