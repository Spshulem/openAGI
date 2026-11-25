import AVFoundation
import Foundation
import Network
import XCTest
@testable import OpenAGI

final class VoiceTests: XCTestCase {
  private func json(_ control: VoiceControl) throws -> [String: Any] {
    guard case .string(let text) = try control.message() else {
      XCTFail("Controls must be text frames")
      return [:]
    }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
  }

  @MainActor
  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<2000 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("Voice fixture did not reach the expected state")
  }

  @MainActor
  private func session(audio: VoiceTestAudio, socket: VoiceTestSocket,
                       microphoneAccess: @escaping () async -> Bool = { true },
                       timeout: Duration = .seconds(20)) -> VoiceSession {
    VoiceSession(audio: audio,
      connection: { try VoiceConnection(base: "https://fixture.invalid", token: "test-daemon-token-1234") },
      microphoneAccess: microphoneAccess, makeSocket: { _ in socket }, connectionTimeout: timeout)
  }

  func testLongReplyBuffersAheadOfPlaybackWithinABoundedQueue() throws {
    var playback = VoicePlayback()
    playback.beginReply()
    // A twenty-second answer arrives before the speaker has drained any audio.
    for _ in 0..<200 { XCTAssertTrue(playback.schedule(2400)) }
    playback.finishReply(itemId: "long_reply", audioMs: 20_000)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
    playback.complete(24_000 * 20)
    XCTAssertEqual(try json(XCTUnwrap(playback.acknowledgements().first))["itemId"] as? String, "long_reply")
    XCTAssertTrue(playback.schedule(24_000 * 120))
    XCTAssertFalse(playback.schedule(1))
    playback.complete(24_000)
    XCTAssertTrue(playback.schedule(24_000))
    playback.reset()
    XCTAssertTrue(playback.schedule(24_000 * 120))
  }

  func testEngineConfigurationChangeFailsAndRemovesTheObserver() async throws {
    let center = NotificationCenter()
    let engine = AVAudioEngine()
    let audio = VoiceAudio(notificationCenter: center)
    let failed = expectation(description: "Device change ends audio")
    failed.assertForOverFulfill = true
    audio.onFailure = { failed.fulfill() }
    audio.prepareEngine(engine)
    center.post(name: .AVAudioEngineConfigurationChange, object: AVAudioEngine())
    XCTAssertTrue(audio.drained) // Wait for the audio queue.
    center.post(name: .AVAudioEngineConfigurationChange, object: engine)
    await fulfillment(of: [failed], timeout: 2)
    center.post(name: .AVAudioEngineConfigurationChange, object: engine)
    XCTAssertEqual(audio.interrupt(), 0)
    XCTAssertTrue(audio.drained)
  }

  func testStoppedEngineFailsBeforeReplyPlaybackOrBargeIn() async throws {
    for barge in [false, true] {
      let audio = VoiceAudio()
      let engine = AVAudioEngine()
      XCTAssertFalse(engine.isRunning)
      audio.prepareEngine(engine)
      let failed = expectation(description: barge ? "Barge detects stopped engine" : "Reply detects stopped engine")
      audio.onFailure = { failed.fulfill() }
      if barge { XCTAssertEqual(audio.interrupt(), 0) }
      else { try audio.play(Data(repeating: 0, count: 4800)) }
      await fulfillment(of: [failed], timeout: 2)
      XCTAssertTrue(audio.drained)
    }
  }

  @MainActor
  func testAudioDeviceFailureEndsCaptureAndClosesTheSession() async throws {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    let voice = session(audio: audio, socket: socket)
    voice.press(.mic, focus: VoiceFocus())
    try await waitUntil { socket.types == ["start"] }
    socket.push(.string("{\"type\":\"ready\"}"))
    try await waitUntil { voice.recording }
    audio.onFailure()
    try await waitUntil { !voice.active }
    XCTAssertFalse(audio.capturing)
    XCTAssertNotNil(voice.error)
    try await waitUntil { socket.closed }
  }

  @MainActor
  func testHeaderCollapseStopsToggleCaptureWithoutShowingAPanel() async throws {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    let voice = session(audio: audio, socket: socket)
    let state = OverlayState(voiceSession: voice)
    state.expanded = true
    voice.press(.mic, focus: VoiceFocus())
    try await waitUntil { socket.types == ["start"] }
    socket.push(.string("{\"type\":\"ready\"}"))
    try await waitUntil { voice.recording }
    // The header's close button writes expanded directly.
    state.expanded = false
    XCTAssertFalse(voice.active)
    XCTAssertFalse(audio.capturing)
    XCTAssertFalse(voice.micHeld)
    try await waitUntil { socket.closed }
    XCTAssertEqual(socket.types, ["start", "stop"])
  }

  @MainActor
  func testDisabledQuickAskIgnoresVoiceHotkeyBeforeAnyStateChange() {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    let voice = session(audio: audio, socket: socket)
    let state = OverlayState(voiceSession: voice, isEnabled: { false })
    // If activation gets past the setting, fail without opening a window.
    state.isLoading = true
    state.beginVoice(.hotkey)
    XCTAssertNil(state.error)
    XCTAssertFalse(state.expanded)
    XCTAssertEqual(state.tab, .tasks)
    XCTAssertFalse(voice.active)
    XCTAssertTrue(socket.types.isEmpty)
    XCTAssertFalse(audio.capturing)
  }

  @MainActor
  func testReleaseFlushesPendingPCMBeforeCommit() async throws {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    let voice = session(audio: audio, socket: socket)
    defer { voice.stop(sendControl: false) }
    voice.press(.mic, focus: VoiceFocus())
    try await waitUntil { socket.types == ["start"] }
    socket.push(.string("{\"type\":\"ready\"}"))
    try await waitUntil { voice.recording }
    // Simulate converted tap buffers whose main-actor notification is delayed.
    audio.pendingPCM = [Data(repeating: 1, count: 2400), Data(repeating: 2, count: 2400)]
    voice.release(.mic)
    XCTAssertFalse(audio.capturing)
    XCTAssertTrue(audio.pendingPCM.isEmpty)
    XCTAssertEqual(voice.phase, .waiting)
    try await waitUntil { socket.types.count == 4 }
    XCTAssertEqual(socket.types, ["start", "pcm", "pcm", "commit"])
    audio.onPCM?()
    await Task.yield()
    XCTAssertEqual(socket.types, ["start", "pcm", "pcm", "commit"])
  }

  @MainActor
  func testMicrophonePromptDoesNotConsumeHubDeadline() async throws {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    var permission: CheckedContinuation<Bool, Never>?
    let voice = session(audio: audio, socket: socket, microphoneAccess: {
      await withCheckedContinuation { permission = $0 }
    }, timeout: .milliseconds(20))
    defer { voice.stop(sendControl: false) }
    voice.press(.mic, focus: VoiceFocus())
    try await waitUntil { permission != nil }
    try await Task.sleep(for: .milliseconds(60))
    XCTAssertEqual(voice.phase, .connecting)
    XCTAssertNil(voice.error)
    XCTAssertTrue(socket.types.isEmpty)
    permission?.resume(returning: true)
    try await waitUntil { socket.types == ["start"] }
    // The hub still gets a bounded deadline after permission is granted.
    try await waitUntil { voice.phase == .idle }
    XCTAssertTrue(voice.error?.contains("didn't start voice in time") == true)
  }

  @MainActor
  func testFocusDuringStartUsesTheSameSerialSender() async throws {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    socket.holdStart = true
    let voice = session(audio: audio, socket: socket)
    defer { voice.stop(sendControl: false) }
    voice.press(.mic, focus: VoiceFocus())
    try await waitUntil { socket.startPending != nil }
    voice.updateFocus(VoiceFocus(threadKey: "codex:new-focus"))
    for _ in 0..<10 { await Task.yield() }
    XCTAssertEqual(socket.types, ["start"])
    XCTAssertEqual(socket.maxConcurrentSends, 1)
    socket.finishStart()
    try await waitUntil { socket.types.count == 2 }
    XCTAssertEqual(socket.types, ["start", "context"])
    XCTAssertEqual(socket.maxConcurrentSends, 1)
    let frame = try XCTUnwrap(socket.messages.last)
    guard case .string(let text) = frame else { return XCTFail("Expected context") }
    XCTAssertTrue(text.contains("codex:new-focus"))
  }

  @MainActor
  func testBargedThenStaleDoneDoesNotFinishTheNewTurn() async throws {
    let audio = VoiceTestAudio()
    let socket = VoiceTestSocket()
    let voice = session(audio: audio, socket: socket)
    defer { voice.stop(sendControl: false) }
    voice.press(.mic, focus: VoiceFocus())
    try await waitUntil { socket.types == ["start"] }
    socket.push(.string("{\"type\":\"ready\"}"))
    try await waitUntil { voice.recording }
    audio.pendingPCM = [Data(repeating: 1, count: 9600)]
    voice.release(.mic)
    socket.push(.data(Data(repeating: 1, count: 4800)))
    try await waitUntil { voice.phase == .replying }
    voice.press(.mic, focus: VoiceFocus())
    audio.pendingPCM = [Data(repeating: 2, count: 9600)]
    voice.release(.mic)
    XCTAssertEqual(voice.phase, .waiting)
    socket.push(.string("{\"type\":\"barged\"}"))
    socket.push(.string("{\"type\":\"reply.done\",\"text\":\"Old reply\",\"itemId\":\"old\",\"audioMs\":100}"))
    socket.push(.string("{\"type\":\"notice\",\"message\":\"barrier\"}"))
    try await waitUntil { voice.notice == "barrier" }
    XCTAssertEqual(voice.phase, .waiting)
    XCTAssertEqual(voice.reply, "")
    XCTAssertEqual(audio.finishedItems, [])
    socket.push(.data(Data(repeating: 2, count: 4800)))
    socket.push(.string("{\"type\":\"reply.done\",\"text\":\"New reply\",\"itemId\":\"new\",\"audioMs\":100}"))
    try await waitUntil { voice.reply == "New reply" }
    XCTAssertEqual(voice.phase, .replying)
    XCTAssertEqual(audio.finishedItems, ["new"])
    audio.drained = true
    audio.onDrained()
    try await waitUntil { voice.phase == .ready }
  }

  func testStartFrameMatchesRelayProtocol() throws {
    let frame = try json(VoiceControl(type: "start", gesture: "hotkey", mode: "ptt", focus: VoiceFocus()))
    XCTAssertEqual(frame["type"] as? String, "start")
    XCTAssertEqual(frame["gesture"] as? String, "hotkey")
    XCTAssertEqual(frame["mode"] as? String, "ptt")
    XCTAssertEqual((frame["focus"] as? [String: Any])?["view"] as? String, "supervisor")
    XCTAssertNil(frame["token"])
    XCTAssertNil(frame["sessionId"])
  }

  func testCommitAndBargeAreTopLevelControls() throws {
    XCTAssertEqual(try json(VoiceControl(type: "commit"))["type"] as? String, "commit")
    let barge = try json(VoiceControl(type: "barge", playedMs: 1250))
    XCTAssertEqual(barge["playedMs"] as? Int, 1250)
    XCTAssertNil(barge["ctrl"])
    XCTAssertNil(barge["focus"])
  }

  func testPlaybackModeAndStopFramesMatchRelayProtocol() throws {
    let playback = try json(VoiceControl(type: "playback", itemId: "item_42", playedMs: 1000.125))
    XCTAssertEqual(Set(playback.keys), ["type", "itemId", "playedMs"])
    XCTAssertEqual(playback["type"] as? String, "playback")
    XCTAssertEqual(playback["itemId"] as? String, "item_42")
    XCTAssertEqual(playback["playedMs"] as? Double, 1000.125)
    let mode = try json(VoiceControl(type: "mode", handsFree: true))
    XCTAssertEqual(Set(mode.keys), ["type", "handsFree"])
    XCTAssertEqual(mode["handsFree"] as? Bool, true)
    XCTAssertEqual(try json(VoiceControl(type: "stop"))["type"] as? String, "stop")
  }

  func testPlaybackAcknowledgementWaitsForAllAudioToPlay() throws {
    var playback = VoicePlayback()
    playback.beginReply()
    playback.schedule(12_000)
    playback.schedule(12_003)
    playback.finishReply(itemId: "item_42", audioMs: 1000.125)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
    playback.complete(12_000)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
    playback.complete(12_003)
    let frame = try json(XCTUnwrap(playback.acknowledgements().first))
    XCTAssertEqual(frame["type"] as? String, "playback")
    XCTAssertEqual(frame["itemId"] as? String, "item_42")
    XCTAssertEqual(frame["playedMs"] as? Double, 1000.125)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
  }

  func testAudioDrainingBeforeReplyDoneWaitsForItemMetadata() throws {
    var playback = VoicePlayback()
    playback.beginReply()
    playback.schedule(24_000)
    playback.complete(24_000)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
    playback.finishReply(itemId: "item_late", audioMs: 1000)
    XCTAssertEqual(try json(XCTUnwrap(playback.acknowledgements().first))["itemId"] as? String, "item_late")
  }

  func testBargeDropsInterruptedAcknowledgementAndCountsPartialPlayback() {
    var playback = VoicePlayback()
    playback.beginReply()
    playback.schedule(12_000)
    playback.schedule(36_000)
    playback.complete(12_000)
    playback.finishReply(itemId: "item_interrupted", audioMs: 2000)
    XCTAssertEqual(playback.playedMs(renderedFrames: 18_000), 750)
    XCTAssertEqual(playback.playedMs(renderedFrames: nil), 500)
    playback.reset()
    XCTAssertTrue(playback.acknowledgements().isEmpty)
    XCTAssertEqual(playback.playedMs(renderedFrames: 18_000), 0)
  }

  func testBargeBeforeReplyDoneDoesNotAcknowledgeOldItem() {
    var playback = VoicePlayback()
    playback.beginReply()
    playback.schedule(24_000)
    playback.complete(12_000)
    playback.reset()
    playback.finishReply(itemId: "item_interrupted", audioMs: 1000)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
  }

  func testConsecutiveItemsAcknowledgeTheirOwnPlaybackBoundary() throws {
    var playback = VoicePlayback()
    playback.beginReply()
    playback.schedule(24_000)
    playback.finishReply(itemId: "item_first", audioMs: 1000)
    playback.beginReply()
    playback.schedule(48_000)
    playback.finishReply(itemId: "item_second", audioMs: 2000)
    XCTAssertEqual(playback.playedMs(renderedFrames: 12_000), 0)
    playback.complete(24_000)
    let first = try json(XCTUnwrap(playback.acknowledgements().first))
    XCTAssertEqual(first["itemId"] as? String, "item_first")
    XCTAssertEqual(first["playedMs"] as? Double, 1000)
    XCTAssertEqual(playback.playedMs(renderedFrames: 30_000), 250)
    playback.complete(48_000)
    let second = try json(XCTUnwrap(playback.acknowledgements().first))
    XCTAssertEqual(second["itemId"] as? String, "item_second")
    XCTAssertEqual(second["playedMs"] as? Double, 2000)
  }

  func testMissingOrMismatchedReplyMetadataNeverAcknowledgesPlayback() {
    var playback = VoicePlayback()
    playback.beginReply()
    playback.schedule(24_000)
    playback.complete(24_000)
    playback.finishReply(itemId: nil, audioMs: 1000)
    playback.finishReply(itemId: "", audioMs: 1000)
    playback.finishReply(itemId: "item_42", audioMs: nil)
    playback.finishReply(itemId: "item_42", audioMs: .infinity)
    playback.finishReply(itemId: "item_42", audioMs: 0)
    playback.finishReply(itemId: "item_42", audioMs: 2000)
    XCTAssertTrue(playback.acknowledgements().isEmpty)
  }

  func testContextFrameKeepsQuestionAndThreadTogether() throws {
    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_42","threadKey":"codex:thread-7","title":"Which branch?"}
      """.utf8))
    let frame = try json(VoiceControl(type: "context", focus: .question(question)))
    let focus = try XCTUnwrap(frame["focus"] as? [String: Any])
    XCTAssertEqual(focus["view"] as? String, "supervisor")
    XCTAssertEqual(focus["threadKey"] as? String, "codex:thread-7")
    XCTAssertEqual(focus["questionId"] as? String, "fq_42")
    XCTAssertNil(focus["title"])
  }

  func testGroupedQuestionUsesChatThreadWhenNoPrimaryThread() throws {
    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data("""
      {"id":"fq_group","chats":[{"threadKey":"codex:a","label":"Agent"}]}
      """.utf8))
    XCTAssertEqual(VoiceFocus.question(question).threadKey, "codex:a")
  }

  func testThreadContextAndClearedFocus() throws {
    let thread = try JSONDecoder().decode(FleetThread.self, from: Data("""
      {"key":"codex:a","title":"Voice","pr":{"ref":"Spshulem/openAGI#201"}}
      """.utf8))
    let focus = VoiceFocus.thread(thread)
    XCTAssertEqual(focus.threadKey, "codex:a")
    XCTAssertEqual(focus.prRef, "Spshulem/openAGI#201")
    XCTAssertNil(focus.questionId)
    let cleared = try json(VoiceControl(type: "context", focus: VoiceFocus()))
    XCTAssertEqual((cleared["focus"] as? [String: Any])?.count, 1)
  }

  func testPTTCommitsOnReleaseOnce() {
    var state = VoicePTT()
    XCTAssertEqual(state.press(.hotkey), [.connect])
    XCTAssertEqual(state.press(.hotkey), [])
    XCTAssertEqual(state.ready(), [.capture])
    state.append(9600)
    XCTAssertEqual(state.release(.hotkey), [.commit])
    XCTAssertEqual(state.phase, .waiting)
    XCTAssertEqual(state.release(.hotkey), [])
  }

  func testReleaseDuringConnectionNeverStartsMicrophone() {
    var state = VoicePTT()
    _ = state.press(.hotkey)
    XCTAssertEqual(state.release(.hotkey), [])
    XCTAssertEqual(state.ready(), [])
    XCTAssertEqual(state.phase, .ready)
    XCTAssertEqual(state.press(.hotkey), [.capture])
  }

  func testBargeBeforeNewCapture() {
    var state = VoicePTT()
    _ = state.press(.mic)
    _ = state.ready()
    state.append(9600)
    _ = state.release(.mic)
    state.reply()
    XCTAssertEqual(state.press(.hotkey), [.barge, .capture])
    state.replyDone()
    XCTAssertEqual(state.phase, .recording)
  }

  func testShortTurnCommitsToClearHubBuffer() {
    var state = VoicePTT()
    _ = state.press(.hotkey)
    _ = state.ready()
    state.append(960)
    XCTAssertEqual(state.release(.hotkey), [.commit])
    XCTAssertEqual(state.phase, .ready)
    _ = state.press(.hotkey)
    XCTAssertEqual(state.release(.hotkey), [])
  }

  func testOverlappingMicAndHotkeyHoldUntilBothRelease() {
    var state = VoicePTT()
    _ = state.press(.mic)
    _ = state.ready()
    XCTAssertEqual(state.press(.hotkey), [])
    state.append(9600)
    XCTAssertEqual(state.release(.mic), [])
    XCTAssertEqual(state.phase, .recording)
    XCTAssertEqual(state.release(.hotkey), [.commit])
  }

  func testResetAfterFailureNeedsNewGesture() {
    var state = VoicePTT()
    _ = state.press(.hotkey)
    state.reset()
    XCTAssertEqual(state.phase, .idle)
    XCTAssertTrue(state.held.isEmpty)
    XCTAssertEqual(state.release(.hotkey), [])
    XCTAssertEqual(state.press(.mic), [.connect])
  }

  func testConnectionUsesSubprotocolTokenNotURLToken() throws {
    let connection = try VoiceConnection(base: "https://hub.example/fleet?token=discarded#card", token: "test-daemon-token-1234")
    XCTAssertEqual(connection.url.absoluteString, "wss://hub.example/nodes/voice?rate=24000&mode=ptt")
    XCTAssertEqual(connection.token, "test-daemon-token-1234")
  }

  func testConnectionRejectsInsecureRemoteOrMissingPairing() throws {
    XCTAssertThrowsError(try VoiceConnection(base: "http://hub.example", token: "test-daemon-token-1234"))
    XCTAssertThrowsError(try VoiceConnection(base: "https://hub.example", token: ""))
    XCTAssertThrowsError(try VoiceConnection(base: "https://user:password@hub.example", token: "test-daemon-token-1234"))
    XCTAssertEqual(try VoiceConnection(base: "http://127.0.0.1:1234", token: "test-daemon-token-1234").url.scheme, "ws")
  }

  // The paired main is often reached over Tailscale (WireGuard-encrypted), as
  // the app already does for every other hub request.
  func testConnectionAcceptsTheHubsTailscaleAddressButNoOtherCleartextHost() throws {
    let tailnetIP = try VoiceConnection(base: "http://100.73.29.88:43210", token: "test-daemon-token-1234")
    XCTAssertEqual(tailnetIP.url.absoluteString, "ws://100.73.29.88:43210/nodes/voice?rate=24000&mode=ptt")
    XCTAssertEqual(try VoiceConnection(base: "http://main.tail1234.ts.net:43210", token: "test-daemon-token-1234").url.scheme, "ws")
    XCTAssertEqual(try VoiceConnection(base: "https://main.tail1234.ts.net:8443", token: "test-daemon-token-1234").url.scheme, "wss")
    XCTAssertThrowsError(try VoiceConnection(base: "http://100.128.0.1", token: "test-daemon-token-1234"), "outside 100.64.0.0/10")
    XCTAssertThrowsError(try VoiceConnection(base: "http://100.73.29.88.evil.example", token: "test-daemon-token-1234"))
    XCTAssertThrowsError(try VoiceConnection(base: "http://ts.net.evil.example", token: "test-daemon-token-1234"))
    XCTAssertThrowsError(try VoiceConnection(base: "http://192.0.2.10", token: "test-daemon-token-1234"))
  }

  func testDisabledVoiceAndAuthenticationErrorsAreClear() {
    XCTAssertTrue(VoiceConnection.failureMessage(status: 404).contains("OPENAGI_VOICE=1"))
    XCTAssertTrue(VoiceConnection.failureMessage(status: 403).contains("daemon token"))
    XCTAssertTrue(VoiceConnection.failureMessage(status: nil).contains("hub configuration"))
  }

  func testDisabledVoiceHandshakeProvidesHTTPStatus() async throws {
    let listener = try NWListener(using: .tcp, on: .any)
    let ready = expectation(description: "Fixture listening")
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.fulfill() }
    }
    listener.newConnectionHandler = { connection in
      connection.start(queue: .global())
      connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
        let response = Data("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    listener.start(queue: .global())
    defer { listener.cancel() }
    await fulfillment(of: [ready], timeout: 5)
    let port = try XCTUnwrap(listener.port)
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let url = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port.rawValue)/nodes/voice"))
    let socket = session.webSocketTask(with: url, protocols: ["openagi-voice", "test-daemon-token-1234"])
    socket.resume()
    do {
      _ = try await socket.receive()
      XCTFail("The disabled relay must reject the upgrade")
    } catch {
      XCTAssertEqual((socket.response as? HTTPURLResponse)?.statusCode, 404)
    }
  }
}

private final class VoiceTestAudio: VoiceAudioDevice {
  var onDrained: () -> Void = {}
  var onFailure: () -> Void = {}
  var onPCM: (() -> Void)?
  var drained = true
  var capturing = false
  var pendingPCM: [Data] = []
  var finishedItems: [String] = []

  func start(onPCM: @escaping () -> Void) async throws { self.onPCM = onPCM }
  func setCapturing(_ on: Bool) { capturing = on }
  func drainCapturedPCM(stopping: Bool) -> [Data] {
    if stopping { capturing = false }
    let pending = pendingPCM
    pendingPCM = []
    return pending
  }
  func beginReply() {}
  func play(_ pcm: Data) throws { drained = false }
  func finishReply(itemId: String?, audioMs: Double?) {
    if let itemId { finishedItems.append(itemId) }
  }
  func playbackAcknowledgements() -> [VoiceControl] { [] }
  func interrupt() -> Int { drained = true; return 0 }
  func stop() { capturing = false; pendingPCM = [] }
}

@MainActor
private final class VoiceTestSocket: VoiceSocket {
  var response: URLResponse? { nil }
  var messages: [URLSessionWebSocketTask.Message] = []
  var holdStart = false
  var startPending: CheckedContinuation<Void, Never>?
  private var pendingReceive: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
  private var incoming: [URLSessionWebSocketTask.Message] = []
  private(set) var closed = false
  private var concurrentSends = 0
  private(set) var maxConcurrentSends = 0

  var types: [String] {
    messages.map { message in
      guard case .string(let text) = message,
            let frame = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return "pcm" }
      return frame["type"] as? String ?? "unknown"
    }
  }

  func resume() {}
  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    concurrentSends += 1
    maxConcurrentSends = max(maxConcurrentSends, concurrentSends)
    defer { concurrentSends -= 1 }
    messages.append(message)
    if holdStart, types.last == "start" {
      await withCheckedContinuation { startPending = $0 }
    }
  }
  func finishStart() { startPending?.resume(); startPending = nil }
  func receive() async throws -> URLSessionWebSocketTask.Message {
    if closed { throw CancellationError() }
    if !incoming.isEmpty { return incoming.removeFirst() }
    return try await withCheckedThrowingContinuation { pendingReceive = $0 }
  }
  func push(_ message: URLSessionWebSocketTask.Message) {
    if let pendingReceive {
      self.pendingReceive = nil
      pendingReceive.resume(returning: message)
    } else { incoming.append(message) }
  }
  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    closed = true
    finishStart()
    pendingReceive?.resume(throwing: CancellationError())
    pendingReceive = nil
  }
}
