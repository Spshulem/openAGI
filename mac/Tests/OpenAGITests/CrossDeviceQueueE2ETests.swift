import XCTest
@testable import OpenAGI

/// Cross-device queue QA (qa/supervisor-queue/README.md). Skipped unless
/// OPENAGI_E2E_HUB is set: the real SharedSupervisorClient talks to a real QA
/// hub with the owner token and writes what this Mac sees to
/// OPENAGI_E2E_OUT/mac.jsonl. Synthetic data only.
@MainActor
final class CrossDeviceQueueE2ETests: XCTestCase {
  private func record(_ supervisor: SharedSupervisorClient, _ label: String, to file: URL) {
    let view: [String: Any] = [
      "device": "mac", "label": label, "at": ISO8601DateFormatter().string(from: Date()),
      "isSending": supervisor.isSending,
      "lastError": supervisor.lastError ?? NSNull(),
      "queued": supervisor.queuedMessages.map { ["text": $0.text, "requestId": $0.requestID] },
      "messages": supervisor.messages.map { ["role": $0.role, "text": String($0.text.prefix(120)), "id": $0.id] }
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: view) else { return }
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile(); handle.write(data); handle.write(Data("\n".utf8)); try? handle.close()
    } else {
      try? (data + Data("\n".utf8)).write(to: file)
    }
  }

  private func until(_ date: Date) async throws {
    let wait = date.timeIntervalSinceNow
    if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
  }

  func testMacQueuesTaggedMessagesWhileThePhonesTurnRuns() async throws {
    let values = ProcessInfo.processInfo.environment
    guard let hub = values["OPENAGI_E2E_HUB"].flatMap(URL.init(string:)), let token = values["OPENAGI_E2E_OWNER_TOKEN"],
          let out = values["OPENAGI_E2E_OUT"], let t0ms = values["OPENAGI_E2E_T0"].flatMap(Double.init) else {
      throw XCTSkip("Cross-device QA runs only against a QA hub")
    }
    let t0 = Date(timeIntervalSince1970: t0ms / 1000)
    let file = URL(fileURLWithPath: out).appendingPathComponent("mac.jsonl")
    let supervisor = SharedSupervisorClient(testSession: URLSession(configuration: .ephemeral), baseURL: hub, token: token)
    await supervisor.refreshMessages()
    record(supervisor, "before", to: file)

    try await until(t0)
    let first = Task { await supervisor.sendMessage("[mac-1] Mac tagged message one") }
    try await Task.sleep(nanoseconds: 50_000_000)
    let second = Task { await supervisor.sendMessage("[mac-2] Mac tagged message two") }
    record(supervisor, "t0+0", to: file)
    try await until(t0.addingTimeInterval(1)); record(supervisor, "t0+1", to: file)
    try await until(t0.addingTimeInterval(5)); await supervisor.refreshMessages(); record(supervisor, "t0+5", to: file)
    _ = await first.value
    _ = await second.value
    let deadline = Date().addingTimeInterval(90)
    while (supervisor.isSending || !supervisor.queuedMessages.isEmpty), Date() < deadline {
      try await Task.sleep(nanoseconds: 250_000_000)
    }
    await supervisor.refreshMessages(); record(supervisor, "settled", to: file)
    try await Task.sleep(nanoseconds: 10_000_000_000)
    await supervisor.refreshMessages(); record(supervisor, "final", to: file)
  }
}
