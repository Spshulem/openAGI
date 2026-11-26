import AppKit
import SupervisorChannelsKit
import XCTest
@testable import OpenAGI

/// Supervisor messages main has not taken yet survive a quit: typed while
/// main was out of reach, they come back on relaunch with the same turn id
/// and go to the hub once, never twice. Messages the hub already has are not
/// kept on the Mac (the hub's queue is durable).
@MainActor
final class MacPendingQueueTests: XCTestCase {
  private var file: URL!

  override func setUp() {
    MacFakeHubProtocol.reset()
    file = FileManager.default.temporaryDirectory
      .appendingPathComponent("openagi-pending-\(UUID().uuidString)", isDirectory: true)
      .appendingPathComponent("supervisor-pending-queue.json")
  }

  override func tearDown() {
    MacFakeHubProtocol.reset()
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  private func client() -> SharedSupervisorClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MacFakeHubProtocol.self]
    let defaults = UserDefaults(suiteName: "mac-pending-\(UUID().uuidString)")!
    BusySendBehavior.queue.store(in: defaults)
    return SharedSupervisorClient(testSession: URLSession(configuration: config), baseURL: URL(string: "http://daemon.test:43210")!,
                                  token: "synthetic", preferences: defaults, pendingQueueURL: file)
  }

  private func waitFor(_ what: String, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !condition() {
      if Date() > deadline { XCTFail("Timed out waiting for \(what)"); return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  func testOnlyMessagesMainHasNotTakenAreSavedAndTheyComeBackInOrderWithTheirIds() throws {
    let image = WorkspaceImageAttachment(id: "img_synthetic01", name: "shot.jpg", mimeType: "image/jpeg",
                                         data: Data([0xFF, 0xD8, 0xFF, 0x00]).base64EncodedString(),
                                         thumbnail: Data([0xFF, 0xD8]).base64EncodedString(),
                                         previewData: Data([0xFF, 0xD8]), preview: NSImage(size: NSSize(width: 1, height: 1)))
    // No hub queue: every item is this Mac's own, including one an edit
    // gave an origin.
    var local = QueuedTurnQueue<SupervisorQueuedPayload>()
    local.enqueue(text: "local only", payload: SupervisorQueuedPayload(focusedCardId: "card:1", attachments: [image]), requestID: "mac-local-0001")
    let edited = local.enqueue(text: "edited here", payload: SupervisorQueuedPayload(focusedCardId: nil, attachments: []), requestID: "mac-edited-002")
    local.setOrigin(edited) { $0.error = nil }
    XCTAssertEqual(SupervisorPendingQueueStore.pending(local, hubQueueAvailable: false).map(\.requestId), ["mac-local-0001", "mac-edited-002"])

    // A hub queue: only what it has not accepted yet.
    var hub = QueuedTurnQueue<SupervisorQueuedPayload>()
    hub.enqueue(text: "on the hub", payload: SupervisorQueuedPayload(focusedCardId: nil, attachments: []), requestID: "mac-onhub-0003",
                origin: QueuedOrigin(mine: true, revision: 1, pendingUpload: false))
    hub.enqueue(text: "send anyway, unanswered", payload: SupervisorQueuedPayload(focusedCardId: nil, attachments: []), requestID: "mac-unsure-004",
                origin: QueuedOrigin(mine: true, pendingUpload: true, sendNext: true, uploadAttempted: true))
    let onHub = SupervisorPendingQueueStore.pending(hub, hubQueueAvailable: true)
    XCTAssertEqual(onHub.map(\.requestId), ["mac-unsure-004"], "the hub's own item is not kept here")

    let store = SupervisorPendingQueueStore(url: file)
    store.save(SupervisorPendingQueueStore.pending(local, hubQueueAvailable: false) + onHub)
    var restored = QueuedTurnQueue<SupervisorQueuedPayload>()
    SupervisorPendingQueueStore.restore(store.load(), into: &restored)
    XCTAssertEqual(restored.items.map(\.text), ["local only", "edited here", "send anyway, unanswered"])
    XCTAssertEqual(restored.items.map(\.requestID), ["mac-local-0001", "mac-edited-002", "mac-unsure-004"])
    XCTAssertNil(restored.items[0].origin)
    XCTAssertEqual(restored.items[0].payload.focusedCardId, "card:1")
    XCTAssertEqual(restored.items[0].payload.attachments.map(\.data), [image.data], "the full image, as it is sent")
    XCTAssertEqual(restored.items[2].origin?.pendingUpload, true)
    XCTAssertEqual(restored.items[2].origin?.uploadAttempted, true, "still possibly on the hub")
    XCTAssertEqual(restored.items[2].origin?.sendNext, true, "still goes next when the hub takes it")

    store.save([])
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "nothing pending, no file")
  }

  func testAMessageWhoseSendIsOutStaysOnDiskUntilMainAnswers() async throws {
    MacHeldStreamProtocol.reset()
    defer { MacHeldStreamProtocol.reset() }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MacHeldStreamProtocol.self]
    let supervisor = SharedSupervisorClient(testSession: URLSession(configuration: config), baseURL: URL(string: "http://daemon.test:43210")!,
                                            token: "synthetic", pendingQueueURL: file)
    MacHeldStreamProtocol.hold.insert("Sent, not answered")
    let send = Task { await supervisor.sendMessage("  Sent, not answered \n", focusedCardId: " card:7 ") }
    try await waitFor("the request to reach main") { MacHeldStreamProtocol.isHeld("Sent, not answered") }
    let requestId = try XCTUnwrap(MacHeldStreamProtocol.sentTurns.first?.requestId)
    let saved = SupervisorPendingQueueStore(url: file).load()
    XCTAssertEqual(saved.map(\.requestId), [requestId], "a quit now still has it, with its turn id")
    XCTAssertEqual(saved.first?.text, "Sent, not answered", "exactly the text on the wire, so a resend is the same message to main")
    XCTAssertEqual(saved.first?.focusedCardId, "card:7")
    XCTAssertEqual(SharedSupervisorClient.wireText("  "), "Please inspect the attached screenshot(s).", "an image-only send, as sent")
    MacHeldStreamProtocol.release("Sent, not answered", frames: "event: final\ndata: {\"reply\":\"Done\"}\n\n")
    _ = await send.value
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "answered: nothing left only on this Mac")
  }

  func testAMessageTypedOfflineSurvivesARelaunchAndReachesTheHubOnce() async throws {
    MacFakeHubProtocol.set { $0 = [.init(requestId: "ios-running-7", text: "iPhone's turn", source: "iPhone", mine: false, state: "running", revision: 1)] }
    var requestId = ""
    do {
      // Scoped, so this "quit" client lets go and its offline retry stops.
      let before = client()
      await before.refreshMessages()
      XCTAssertTrue(before.hubQueueAvailable)
      MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.offlineEnqueue = true }
      _ = await before.sendMessage("typed while main was out of reach")
      try await waitFor("the failed upload") { MacFakeHubProtocol.calls().contains { $0.hasPrefix("POST /conversations/supervisor/queue") } }
      requestId = try XCTUnwrap(before.queuedMessages.first?.requestID)
      let saved = requestId
      try await waitFor("the message on disk") { SupervisorPendingQueueStore(url: self.file).load().map(\.requestId) == [saved] }
    }

    // The app quits and opens again; main is reachable now.
    let after = client()
    XCTAssertEqual(after.queuedMessages.map(\.text), ["typed while main was out of reach"])
    XCTAssertEqual(after.queuedMessages.first?.requestID, requestId, "the same turn id, so main runs it once")
    MacFakeHubProtocol.lock.withLock { MacFakeHubProtocol.offlineEnqueue = false }
    await after.refreshMessages()
    try await waitFor("the hub to take it") { MacFakeHubProtocol.snapshot().contains { $0.requestId == requestId } }
    try await waitFor("nothing left only on this Mac") { !FileManager.default.fileExists(atPath: self.file.path) }
    XCTAssertEqual(MacFakeHubProtocol.snapshot().filter { $0.requestId == requestId }.count, 1)
    XCTAssertEqual(after.queuedMessages.map(\.requestID), [requestId], "shown as the hub's waiting message")
    XCTAssertEqual(after.queuedMessages.first?.origin?.pendingUpload, false)
  }
}
