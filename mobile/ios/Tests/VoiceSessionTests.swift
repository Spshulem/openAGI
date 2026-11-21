import XCTest
@testable import OpenAGI

// Voice Mode's phone side (Sources/Voice), against fakes for the socket and
// audio. Mirrors Android's VoiceSessionTest so both clients keep the
// protocol in src/voice/relay.js.
final class VoiceStateMachineTests: XCTestCase {
    func testReleaseBeforeReadyNeverRecords() {
        var state = VoiceStateMachine()
        state.start(handsFree: false, held: true)
        XCTAssertTrue(state.release().isEmpty)
        XCTAssertTrue(state.ready().isEmpty)
        XCTAssertFalse(state.recording)
        XCTAssertEqual(state.press(), [.barge, .startCapture])
    }

    func testReleaseStopsCaptureAndCommitsOnce() {
        var state = VoiceStateMachine()
        state.start(handsFree: false, held: true)
        XCTAssertEqual(state.ready(), [.startCapture])
        XCTAssertTrue(state.ready().isEmpty)
        XCTAssertEqual(state.release(), [.stopCapture, .commit])
        XCTAssertTrue(state.release().isEmpty)
    }

    func testCancelledGestureDoesNotCommit() {
        var state = VoiceStateMachine()
        state.start(handsFree: false, held: true)
        _ = state.ready()
        XCTAssertEqual(state.release(commit: false), [.stopCapture, .cancel])
    }

    func testHandsFreeCapturesUntilDisabledWithoutCommit() {
        var state = VoiceStateMachine()
        state.start(handsFree: true, held: false)
        XCTAssertEqual(state.ready(), [.startCapture])
        XCTAssertTrue(state.press().isEmpty)
        XCTAssertTrue(state.release().isEmpty)
        XCTAssertEqual(state.mode(false), [.stopCapture])
        XCTAssertEqual(state.mode(true), [.startCapture])
        XCTAssertEqual(state.stop(), [.stopCapture])
        XCTAssertEqual(state.phase, .idle)
        XCTAssertFalse(state.handsFree)
    }

    func testModeChangesDuringConnectApplyWhenReady() {
        var state = VoiceStateMachine()
        state.start(handsFree: false, held: false)
        XCTAssertTrue(state.mode(true).isEmpty)
        XCTAssertTrue(state.mode(false).isEmpty)
        XCTAssertTrue(state.ready().isEmpty)
    }

    func testStoppedSessionIgnoresLateReady() {
        var state = VoiceStateMachine()
        state.start(handsFree: true, held: false)
        _ = state.stop()
        XCTAssertTrue(state.ready().isEmpty)
        XCTAssertFalse(state.recording)
    }
}

final class VoiceFramesTests: XCTestCase {
    private func object(_ text: String) -> [String: Any] { VoiceFrames.decode(text) ?? [:] }

    func testStartEscapesFocusAndCarriesNoCredentials() {
        let frame = object(VoiceFrames.start(handsFree: false, focus: VoiceFocus(threadKey: "thread:\"one", questionId: "q1")))
        XCTAssertEqual(VoiceFrames.field(frame, "type"), "start")
        XCTAssertEqual(VoiceFrames.field(frame, "gesture"), "mic")
        XCTAssertEqual(VoiceFrames.field(frame, "mode"), "ptt")
        let focus = frame["focus"] as? [String: Any] ?? [:]
        XCTAssertEqual(focus["threadKey"] as? String, "thread:\"one")
        XCTAssertEqual(focus["questionId"] as? String, "q1")
        XCTAssertNil(focus["actionId"], "unset focus fields are omitted")
        XCTAssertFalse(VoiceFrames.start(handsFree: true, focus: VoiceFocus()).contains("token"))
    }

    func testEmptyContextClearsTarget() {
        let focus = object(VoiceFrames.context(VoiceFocus()))["focus"] as? [String: Any] ?? [:]
        XCTAssertEqual(Set(focus.keys), ["view"])
    }

    func testControlsMatchHubProtocol() {
        XCTAssertEqual(VoiceFrames.field(object(VoiceFrames.start(handsFree: true, focus: VoiceFocus())), "mode"), "handsfree")
        XCTAssertEqual(VoiceFrames.field(object(VoiceFrames.mode(handsFree: true)), "handsFree"), "true")
        XCTAssertEqual(VoiceFrames.field(object(VoiceFrames.control("barge", playedMs: -1)), "playedMs"), "0")
        XCTAssertEqual(VoiceFrames.control("commit"), #"{"type":"commit"}"#)
        XCTAssertEqual(VoiceFrames.control("stop"), #"{"type":"stop"}"#)
        let playback = object(VoiceFrames.playback(itemId: "item1", playedMs: 125.5))
        XCTAssertEqual(Set(playback.keys), ["type", "itemId", "playedMs"])
        XCTAssertEqual(VoiceFrames.field(playback, "itemId"), "item1")
        XCTAssertEqual(VoiceFrames.field(playback, "playedMs"), "125.5")
    }

    func testMalformedAndFutureEventsAreSafe() {
        XCTAssertNil(VoiceFrames.decode("not json"))
        XCTAssertNil(VoiceFrames.decode("[]"))
        XCTAssertEqual(VoiceFrames.field(object(#"{"type":"future","newField":1}"#), "type"), "future")
        XCTAssertNil(VoiceFrames.field(object(#"{"type":{}}"#), "type"))
    }

    func testVoiceURLUsesTheSocketSchemeAndNeverTheToken() {
        let secure = VoiceSession.voiceURL(server: URL(string: "https://mac.tail1234.ts.net:43210/some/path?x=1")!, handsFree: true)
        XCTAssertEqual(secure?.absoluteString, "wss://mac.tail1234.ts.net:43210/nodes/voice?rate=24000&mode=handsfree")
        let plain = VoiceSession.voiceURL(server: URL(string: "http://192.168.1.4:43210")!, handsFree: false)
        XCTAssertEqual(plain?.absoluteString, "ws://192.168.1.4:43210/nodes/voice?rate=24000&mode=ptt")
        XCTAssertNil(VoiceSession.voiceURL(server: URL(string: "ftp://host")!, handsFree: true))
    }

    func testStateLabelsAreExplicit() {
        XCTAssertNil(SupervisorVoiceBar.stateLabel(VoiceStatus()))
        XCTAssertEqual(SupervisorVoiceBar.stateLabel(VoiceStatus(phase: .connecting)), "Connecting…")
        XCTAssertEqual(SupervisorVoiceBar.stateLabel(VoiceStatus(phase: .ready, recording: true)), "Listening")
        XCTAssertEqual(SupervisorVoiceBar.stateLabel(VoiceStatus(phase: .ready, recording: true, speaking: true)), "Speaking")
    }
}

@MainActor
final class VoiceSessionTests: XCTestCase {
    private let token = String(repeating: "a", count: 43)
    private let server = URL(string: "https://mac.tail1234.ts.net:43210")!

    final class FakeTransport: VoiceTransport {
        var onOpen: (() -> Void)?
        var onText: ((String) -> Void)?
        var onData: ((Data) -> Void)?
        var onFailure: ((Int?) -> Void)?
        var onClosed: (() -> Void)?
        let url: URL
        let protocols: [String]
        var connected = false
        var texts: [String] = []
        var data: [Data] = []
        var closedGracefully: Bool?
        var acceptSends = true

        init(url: URL, protocols: [String]) { self.url = url; self.protocols = protocols }
        func connect() { connected = true }
        func send(text: String) -> Bool { texts.append(text); return acceptSends }
        func send(data: Data) -> Bool { self.data.append(data); return acceptSends }
        func close(graceful: Bool) { closedGracefully = graceful }
        func types() -> [String] { texts.compactMap { VoiceFrames.decode($0).flatMap { VoiceFrames.field($0, "type") } } }
        func receive(_ object: [String: Any]) {
            onText?(String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self))
        }
    }

    final class FakeAudio: VoiceAudioIO {
        var opened = false
        var openAllowed = true
        var capturing = false
        var onAudio: ((Data) -> Void)?
        var played: [Data] = []
        var completions: [(Double, () -> Void)] = []
        var barges = 0
        var closes = 0
        var interrupt: (() -> Void)?

        func open(onInterrupted: @escaping @MainActor () -> Void) -> Bool { interrupt = onInterrupted; opened = openAllowed; return openAllowed }
        func startCapture(onAudio: @escaping @MainActor (Data) -> Void, onError: @escaping @MainActor () -> Void) throws {
            capturing = true
            self.onAudio = onAudio
        }
        func stopCapture() { capturing = false }
        func play(_ pcm: Data, onError: @escaping @MainActor () -> Void) -> Bool { played.append(pcm); return true }
        func completeReply(audioMs: Double, onPlayed: @escaping @MainActor () -> Void) { completions.append((audioMs, onPlayed)) }
        func barge() -> Int { barges += 1; return 125 }
        func close() { capturing = false; opened = false; closes += 1 }
    }

    private func session(audio: FakeAudio = FakeAudio()) -> (VoiceSession, FakeAudio, () -> FakeTransport?) {
        var made: FakeTransport?
        let session = VoiceSession(server: server, token: token, audio: audio, enforceAllowlist: false) { url, protocols in
            let transport = FakeTransport(url: url, protocols: protocols)
            made = transport
            return transport
        }
        return (session, audio, { made })
    }

    func testOneTapStartsAContinuousConversationWithTheTokenOnlyInTheSubprotocol() throws {
        let (voice, audio, transport) = session()
        voice.handsFree(true)
        XCTAssertEqual(voice.status.phase, .connecting)
        let socket = try XCTUnwrap(transport())
        XCTAssertTrue(socket.connected)
        XCTAssertEqual(socket.url.absoluteString, "wss://mac.tail1234.ts.net:43210/nodes/voice?rate=24000&mode=handsfree")
        XCTAssertEqual(socket.protocols, ["openagi-voice", token])
        XCTAssertFalse(socket.url.absoluteString.contains(token))
        XCTAssertTrue(audio.opened)
        XCTAssertFalse(audio.capturing, "no microphone before the hub is ready")

        socket.onOpen?()
        XCTAssertEqual(socket.types(), ["start"])
        XCTAssertEqual(VoiceFrames.field(VoiceFrames.decode(socket.texts[0])!, "mode"), "handsfree")
        socket.receive(["type": "ready"])
        XCTAssertEqual(voice.status.phase, .ready)
        XCTAssertTrue(audio.capturing)
        XCTAssertTrue(voice.status.recording)

        audio.onAudio?(Data([1, 0, 2, 0]))
        XCTAssertEqual(socket.data, [Data([1, 0, 2, 0])], "captured audio goes up as binary frames")
    }

    func testRepliesPlayInterruptCleanlyAndReportWhatWasHeard() throws {
        let (voice, audio, transport) = session()
        var saved = 0
        voice.onTurnSaved = { saved += 1 }
        voice.handsFree(true)
        let socket = try XCTUnwrap(transport())
        socket.onOpen?()
        socket.receive(["type": "ready"])

        socket.onData?(Data([0, 1, 0, 1]))
        XCTAssertEqual(audio.played.count, 1)
        XCTAssertTrue(voice.status.speaking)
        // The owner talks over the reply.
        socket.receive(["type": "speech_started"])
        XCTAssertEqual(audio.barges, 1)
        XCTAssertFalse(voice.status.speaking)
        let barge = VoiceFrames.decode(try XCTUnwrap(socket.texts.last))!
        XCTAssertEqual(VoiceFrames.field(barge, "type"), "barge")
        XCTAssertEqual(VoiceFrames.field(barge, "playedMs"), "125")
        socket.onData?(Data([0, 1]))
        XCTAssertEqual(audio.played.count, 1, "audio from the interrupted reply is dropped")
        socket.receive(["type": "barged"])
        XCTAssertEqual(audio.barges, 2, "the hub's barged also clears local playback, as on Android")

        socket.receive(["type": "reply.delta", "text": "Two things "])
        socket.receive(["type": "reply.delta", "text": "need you."])
        XCTAssertEqual(voice.status.replyText, "Two things need you.")
        socket.onData?(Data([0, 2, 0, 2]))
        socket.receive(["type": "reply.done", "text": "Two things need you.", "itemId": "item-9", "audioMs": 320])
        XCTAssertEqual(saved, 1, "each finished turn reloads the shared Supervisor thread")
        XCTAssertEqual(audio.completions.first?.0, 320)
        audio.completions.first?.1()
        let playback = VoiceFrames.decode(try XCTUnwrap(socket.texts.last))!
        XCTAssertEqual(VoiceFrames.field(playback, "type"), "playback")
        XCTAssertEqual(VoiceFrames.field(playback, "itemId"), "item-9")
        XCTAssertFalse(voice.status.speaking)
        // A fully heard reply is not cut short by the next speech.
        socket.receive(["type": "speech_started"])
        XCTAssertEqual(audio.barges, 2)
    }

    func testStopEndsEverythingAndReloadsTheChat() throws {
        let (voice, audio, transport) = session()
        var saved = 0
        voice.onTurnSaved = { saved += 1 }
        voice.handsFree(true)
        let socket = try XCTUnwrap(transport())
        socket.onOpen?()
        socket.receive(["type": "ready"])
        voice.stop()
        XCTAssertEqual(socket.types().last, "stop")
        XCTAssertEqual(socket.closedGracefully, true)
        XCTAssertFalse(audio.capturing)
        XCTAssertFalse(audio.opened)
        XCTAssertEqual(voice.status.phase, .idle)
        XCTAssertFalse(voice.status.recording)
        XCTAssertEqual(saved, 1, "after voice, the chat reloads so typing continues the same history")
        // Late events from the closed socket change nothing.
        socket.receive(["type": "ready"])
        socket.onData?(Data([0, 1]))
        XCTAssertEqual(voice.status.phase, .idle)
        XCTAssertFalse(audio.capturing)
    }

    func testRefusedUpgradesExplainWhatToDo() throws {
        for (code, words) in [(404, "Voice is off on this hub"), (403, "Re-pair this phone"), (429, "busy with voice"), (500, "Voice disconnected")] {
            let (voice, audio, transport) = session()
            voice.handsFree(true)
            try XCTUnwrap(transport()).onFailure?(code)
            XCTAssertEqual(voice.status.phase, .idle)
            XCTAssertTrue(voice.status.message?.contains(words) == true, "\(code): \(voice.status.message ?? "nil")")
            XCTAssertFalse(audio.opened)
            XCTAssertFalse(audio.capturing)
        }
    }

    func testAReleaseWhileConnectingNeverTurnsTheMicrophoneOnLater() throws {
        let (voice, audio, transport) = session()
        voice.press()
        voice.release()
        let socket = try XCTUnwrap(transport())
        socket.onOpen?()
        socket.receive(["type": "ready"])
        XCTAssertFalse(audio.capturing)
        XCTAssertFalse(socket.types().contains("commit"))
    }

    func testABadCredentialOrBusyAudioNeverOpensASocket() {
        let badAudio = FakeAudio()
        badAudio.openAllowed = false
        let (busy, _, busyTransport) = session(audio: badAudio)
        busy.handsFree(true)
        XCTAssertNil(busyTransport())
        XCTAssertEqual(busy.status.phase, .idle)
        XCTAssertNotNil(busy.status.message)

        var made = false
        let bad = VoiceSession(server: server, token: "short", audio: FakeAudio(), enforceAllowlist: false) { url, protocols in
            made = true
            return FakeTransport(url: url, protocols: protocols)
        }
        bad.handsFree(true)
        XCTAssertFalse(made)
        XCTAssertEqual(bad.status.message, "Voice could not connect. Check the paired hub and try again.")
    }

    func testAudioInterruptionEndsVoice() throws {
        let (voice, audio, transport) = session()
        voice.handsFree(true)
        let socket = try XCTUnwrap(transport())
        socket.onOpen?()
        socket.receive(["type": "ready"])
        audio.interrupt?()
        XCTAssertEqual(voice.status.phase, .idle)
        XCTAssertTrue(voice.status.message?.contains("another app needs audio") == true)
        XCTAssertNotNil(socket.closedGracefully)
    }

    func testHubEndAndUploadBackpressureEndTheSession() throws {
        let (voice, _, transport) = session()
        voice.handsFree(true)
        let socket = try XCTUnwrap(transport())
        socket.onOpen?()
        socket.receive(["type": "ready"])
        socket.receive(["type": "end", "reason": "Voice went quiet for two minutes and closed."])
        XCTAssertEqual(voice.status.phase, .idle)
        XCTAssertEqual(voice.status.message, "Voice went quiet for two minutes and closed.")

        let (second, audio, secondTransport) = session()
        second.handsFree(true)
        let other = try XCTUnwrap(secondTransport())
        other.onOpen?()
        other.receive(["type": "ready"])
        other.acceptSends = false
        audio.onAudio?(Data([1, 0]))
        XCTAssertEqual(second.status.phase, .idle)
        XCTAssertEqual(second.status.message, "Voice upload fell behind. Start again.")
    }
}
