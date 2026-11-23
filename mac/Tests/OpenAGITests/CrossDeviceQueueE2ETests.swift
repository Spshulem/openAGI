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
      "hubQueue": supervisor.hubQueueAvailable,
      "hubRunning": supervisor.hubRunning?.text ?? NSNull(),
      "queued": supervisor.queuedMessages.map { item -> [String: Any] in
        ["text": item.text, "requestId": item.requestID, "from": item.origin?.sourceName ?? NSNull(),
         "mine": item.origin?.mine ?? true, "heldBy": item.origin?.heldBy ?? NSNull(),
         "pending": item.origin?.pendingUpload ?? false, "error": item.origin?.error ?? NSNull(),
         "sendNow": item.sendNow?.label ?? NSNull()]
      },
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
    while (supervisor.isSending || !supervisor.queuedMessages.isEmpty || supervisor.hubRunning != nil), Date() < deadline {
      try await Task.sleep(nanoseconds: 500_000_000)
      await supervisor.refreshMessages()
    }
    await supervisor.refreshMessages(); record(supervisor, "settled", to: file)
    try await Task.sleep(nanoseconds: 10_000_000_000)
    await supervisor.refreshMessages(); record(supervisor, "final", to: file)

    // Phase 2 (hub queue only): edits, removals and Send Now across devices.
    guard supervisor.hubQueueAvailable else { return }
    let t1 = t0.addingTimeInterval(70)
    try await until(t1.addingTimeInterval(1)); await supervisor.refreshMessages()
    _ = await supervisor.sendMessage("[mac-3] Mac message to edit")
    _ = await supervisor.sendMessage("[mac-4] Mac message the iPhone will remove")
    record(supervisor, "p2-queued-mac-3-4", to: file)
    try await until(t1.addingTimeInterval(5)); await supervisor.refreshMessages()
    if let three = supervisor.queuedMessages.first(where: { $0.text.hasPrefix("[mac-3]") }) {
      _ = supervisor.beginEditingQueued(id: three.id)
      supervisor.queuedEditDraft = "[mac-3] edited on the Mac while the iPhone tried"
    }
    try await Task.sleep(nanoseconds: 1_000_000_000); record(supervisor, "p2-editing-mac-3", to: file)
    try await until(t1.addingTimeInterval(10))
    _ = supervisor.saveQueuedEdit()
    try await Task.sleep(nanoseconds: 1_000_000_000); await supervisor.refreshMessages(); record(supervisor, "p2-saved-mac-3", to: file)
    try await until(t1.addingTimeInterval(12)); await supervisor.refreshMessages()
    if let six = supervisor.queuedMessages.first(where: { $0.text.hasPrefix("[ios-6]") }) {
      await supervisor.sendQueuedNow(id: six.id)
    }
    record(supervisor, "p2-sent-now-ios-6", to: file)
    let deadline2 = Date().addingTimeInterval(60)
    while (supervisor.isSending || !supervisor.queuedMessages.isEmpty || supervisor.hubRunning != nil), Date() < deadline2 {
      try await Task.sleep(nanoseconds: 500_000_000); await supervisor.refreshMessages()
    }
    record(supervisor, "p2-final", to: file)
  }
}
