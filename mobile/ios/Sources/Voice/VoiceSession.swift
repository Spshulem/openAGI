import Foundation
import Observation

// The socket to WSS /nodes/voice. A seam so VoiceSession is testable without
// a network: the real one is URLSessionVoiceTransport.
@MainActor
protocol VoiceTransport: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onText: ((String) -> Void)? { get set }
    var onData: ((Data) -> Void)? { get set }
    // The upgrade or the connection failed; the HTTP status when the hub
    // refused the upgrade (404 voice off, 403 credential, 429 busy).
    var onFailure: ((Int?) -> Void)? { get set }
    var onClosed: (() -> Void)? { get set }
    func connect()
    // False when the upload backlog is too large (the caller ends the session).
    func send(text: String) -> Bool
    func send(data: Data) -> Bool
    func close(graceful: Bool)
}

typealias VoiceTransportFactory = @MainActor (_ url: URL, _ protocols: [String]) -> VoiceTransport

// Microphone and speaker. A seam so VoiceSession is testable without audio
// hardware: the real one is VoiceAudio (AVAudioEngine).
@MainActor
protocol VoiceAudioIO: AnyObject {
    // Claim the audio session; onInterrupted fires if another app takes it.
    func open(onInterrupted: @escaping @MainActor () -> Void) -> Bool
    // 24 kHz PCM16 mono chunks.
    func startCapture(onAudio: @escaping @MainActor (Data) -> Void, onError: @escaping @MainActor () -> Void) throws
    func stopCapture()
    // Queue 24 kHz PCM16 mono reply audio. False when playback fell behind.
    func play(_ pcm: Data, onError: @escaping @MainActor () -> Void) -> Bool
    // The reply's audio is complete; onPlayed fires once it has all been heard.
    func completeReply(audioMs: Double, onPlayed: @escaping @MainActor () -> Void)
    // Stop playback now; milliseconds of the current reply that were heard.
    func barge() -> Int
    func close()
}

// One voice conversation with the Supervisor, through the hub. Ported from
// Android's VoiceSession: same frames, same state machine, same failure copy.
// The hub writes both sides of every turn into the shared Supervisor thread,
// so this never adds chat lines itself; onTurnSaved asks the chat to reload.
@MainActor
@Observable
final class VoiceSession {
    private(set) var status = VoiceStatus()
    // A turn finished or the session ended: reload the Supervisor thread.
    @ObservationIgnored var onTurnSaved: (() -> Void)?

    @ObservationIgnored private let server: URL
    @ObservationIgnored private let token: String
    @ObservationIgnored private let audio: VoiceAudioIO
    @ObservationIgnored private let makeTransport: VoiceTransportFactory
    @ObservationIgnored private let enforceAllowlist: Bool
    @ObservationIgnored private var machine = VoiceStateMachine()
    @ObservationIgnored private var transport: VoiceTransport?
    @ObservationIgnored private var focus = VoiceFocus()
    @ObservationIgnored private var replyDone = true
    @ObservationIgnored private var discardAudio = false
    @ObservationIgnored private var closed = false
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var captureGeneration = 0
    @ObservationIgnored private var playbackGeneration = 0
    @ObservationIgnored private var replyPlayed = false
    @ObservationIgnored private var replyRevision = 0

    static let tokenPattern = /^[A-Za-z0-9._~+-]{16,512}$/

    init(server: URL, token: String, audio: VoiceAudioIO,
         enforceAllowlist: Bool = true,
         makeTransport: @escaping VoiceTransportFactory = { url, protocols in URLSessionVoiceTransport(url: url, protocols: protocols) }) {
        self.server = server
        self.token = token
        self.audio = audio
        self.enforceAllowlist = enforceAllowlist
        self.makeTransport = makeTransport
    }

    // Push-to-talk hold (kept for parity with Android; the iPhone UI uses
    // hands-free).
    func press() {
        if closed { return }
        if machine.phase == .idle { connect(handsFree: false, held: true) } else { apply(machine.press()) }
    }

    func release(commit: Bool = true) {
        apply(machine.release(commit: commit))
    }

    // One tap: a continuous conversation. Off ends it.
    func handsFree(_ on: Bool) {
        if closed { return }
        if machine.phase == .idle {
            if on { connect(handsFree: true, held: false) }
        } else {
            if opened && !send(VoiceFrames.mode(handsFree: on)) { return }
            // End a hands-free turn so partial audio cannot spill into the next hold.
            if !on && machine.handsFree { stop() } else { apply(machine.mode(on)) }
        }
    }

    func setFocus(_ next: VoiceFocus) {
        if next == focus { return }
        focus = next
        if opened { _ = send(VoiceFrames.context(next)) }
    }

    func stop() {
        if let transport { _ = transport.send(text: VoiceFrames.control("stop")) }
        finish(nil, graceful: true)
    }

    func close() {
        stop()
        closed = true
    }

    // ws(s)://host/nodes/voice?rate=24000&mode=…, from the paired server URL.
    nonisolated static func voiceURL(server: URL, handsFree: Bool) -> URL? {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: return nil
        }
        components.path = "/nodes/voice"
        components.queryItems = [URLQueryItem(name: "rate", value: "24000"),
                                 URLQueryItem(name: "mode", value: handsFree ? "handsfree" : "ptt")]
        components.fragment = nil
        return components.url
    }

    nonisolated static func failureMessage(status: Int?) -> String {
        switch status {
        case 404: "Voice is off on this hub. Enable OPENAGI_VOICE=1 on the hub and restart it."
        case 403: "Voice access was refused. Re-pair this phone in Settings."
        case 429: "The hub is busy with voice. Try again shortly."
        default: "Voice disconnected. Check the hub connection and try again."
        }
    }

    private func connect(handsFree: Bool, held: Bool) {
        machine.start(handsFree: handsFree, held: held)
        status = VoiceStatus(phase: .connecting, handsFree: handsFree, message: "Connecting voice…")
        replyDone = true
        replyPlayed = false
        discardAudio = false
        let origin: URL? = enforceAllowlist ? (try? HostAllowlist.validate(server)) : server
        guard token.wholeMatch(of: Self.tokenPattern) != nil,
              let origin,
              let url = Self.voiceURL(server: origin, handsFree: handsFree) else {
            finish("Voice could not connect. Check the paired hub and try again.")
            return
        }
        guard audio.open(onInterrupted: { [weak self] in
            self?.finish("Voice paused because another app needs audio. Start voice again.")
        }) else {
            finish("Voice needs the microphone and speaker. Pause other audio and try again.")
            return
        }
        // The credential travels only as the WebSocket subprotocol, never in the URL.
        let next = makeTransport(url, ["openagi-voice", token])
        transport = next
        next.onOpen = { [weak self, weak next] in
            guard let self, let next, next === self.transport else { return }
            self.opened = true
            _ = self.send(VoiceFrames.start(handsFree: self.machine.handsFree, focus: self.focus))
        }
        next.onText = { [weak self, weak next] text in
            guard let self, let next, next === self.transport else { return }
            self.handle(text)
        }
        next.onData = { [weak self, weak next] data in
            guard let self, let next, next === self.transport else { return }
            self.handleAudio(data)
        }
        next.onFailure = { [weak self, weak next] code in
            guard let self, let next, next === self.transport else { return }
            self.finish(Self.failureMessage(status: code))
        }
        next.onClosed = { [weak self, weak next] in
            guard let self, let next, next === self.transport else { return }
            self.finish("Voice ended. Start again when ready.")
        }
        next.connect()
    }

    private func handle(_ text: String) {
        guard let frame = VoiceFrames.decode(text) else { return }
        func field(_ key: String) -> String? { VoiceFrames.field(frame, key) }
        switch field("type") {
        case "ready":
            status.message = nil
            apply(machine.ready())
        case "transcript":
            if field("role") == "owner" { status.ownerText = String((field("text") ?? "").prefix(4000)) }
        case "reply.delta":
            replyRevision += 1
            replyPlayed = false
            let previous = replyDone ? "" : status.replyText
            replyDone = false
            status.replyText = String((previous + (field("text") ?? "")).prefix(4000))
        case "reply.done":
            replyDone = true
            status.replyText = String((field("text") ?? "").prefix(4000))
            if let itemId = field("itemId"), !itemId.isEmpty, itemId != "null",
               let audioMs = field("audioMs").flatMap(Double.init), audioMs.isFinite, audioMs > 0, !discardAudio {
                let generation = playbackGeneration
                let revision = replyRevision
                audio.completeReply(audioMs: audioMs) { [weak self] in
                    guard let self, generation == self.playbackGeneration, !self.discardAudio, self.transport != nil else { return }
                    if self.send(VoiceFrames.playback(itemId: itemId, playedMs: audioMs)) && revision == self.replyRevision {
                        self.replyPlayed = true
                    }
                    self.status.speaking = false
                }
            } else {
                status.speaking = false
            }
            onTurnSaved?()
        case "speech_started":
            barge()
        case "barged":
            playbackGeneration += 1
            _ = audio.barge()
            discardAudio = false
            status.speaking = false
        case "end":
            finish(field("reason").map { String($0.prefix(200)) } ?? "Voice ended.")
        case "error", "notice":
            status.message = field("message").map { String($0.prefix(240)) }
        case "confirmation.readback":
            status.message = field("text").map { String($0.prefix(1000)) }
        case "tool":
            status.message = field("summary") ?? "\(field("name") ?? ""): \(field("status") ?? "")"
        default:
            break
        }
    }

    private func handleAudio(_ data: Data) {
        if discardAudio { return }
        replyPlayed = false
        replyRevision += 1
        let generation = playbackGeneration
        guard !data.isEmpty, data.count % 2 == 0, audio.play(data, onError: { [weak self] in
            guard let self, generation == self.playbackGeneration else { return }
            self.finish("Reply playback failed. Start voice again.")
        }) else {
            finish("Reply audio fell behind. Start voice again.")
            return
        }
        status.speaking = true
    }

    private func send(_ text: String) -> Bool {
        // Context and mode are included in start after the handshake.
        guard let transport else { return true }
        if !transport.send(text: text) {
            finish("Voice upload fell behind. Start again.")
            return false
        }
        return true
    }

    private func barge() {
        // A new push-to-talk hold must not invalidate a fully heard readback.
        if replyPlayed { return }
        playbackGeneration += 1
        let played = audio.barge()
        discardAudio = true
        status.speaking = false
        _ = send(VoiceFrames.control("barge", playedMs: played))
    }

    private func apply(_ effects: [VoiceEffect]) {
        for effect in effects {
            switch effect {
            case .startCapture:
                captureGeneration += 1
                let generation = captureGeneration
                do {
                    try audio.startCapture(onAudio: { [weak self] pcm in
                        guard let self, generation == self.captureGeneration, self.machine.recording,
                              let transport = self.transport else { return }
                        if !transport.send(data: pcm) { self.finish("Voice upload fell behind. Start again.") }
                    }, onError: { [weak self] in
                        guard let self, generation == self.captureGeneration else { return }
                        self.finish("Microphone unavailable. Check microphone permission and try again.")
                    })
                } catch {
                    finish("Microphone unavailable. Check microphone permission and try again.")
                    return
                }
            case .stopCapture:
                captureGeneration += 1
                audio.stopCapture()
            case .commit:
                if !send(VoiceFrames.control("commit")) { return }
            case .cancel:
                if !send(VoiceFrames.control("cancel")) { return }
            case .barge:
                barge()
            }
        }
        status.phase = machine.phase
        status.handsFree = machine.handsFree
        status.recording = machine.recording
    }

    private func finish(_ message: String?, graceful: Bool = false) {
        let wasActive = machine.phase != .idle || transport != nil
        playbackGeneration += 1
        apply(machine.stop())
        audio.close()
        let ended = transport
        transport = nil
        opened = false
        ended?.close(graceful: graceful)
        status.speaking = false
        status.message = message
        if wasActive { onTurnSaved?() }
    }
}

// URLSessionWebSocketTask behind VoiceTransport. Delegate callbacks arrive on
// the main queue; the upload backlog is bounded like Android's 256 KB queue.
@MainActor
final class URLSessionVoiceTransport: NSObject, VoiceTransport, URLSessionWebSocketDelegate {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onData: ((Data) -> Void)?
    var onFailure: ((Int?) -> Void)?
    var onClosed: (() -> Void)?

    private let url: URL
    private let protocols: [String]
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pendingBytes = 0
    private var finished = false
    static let maxBacklog = 256_000

    init(url: URL, protocols: [String]) {
        self.url = url
        self.protocols = protocols
    }

    func connect() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        let task = session.webSocketTask(with: url, protocols: protocols)
        self.task = task
        task.resume()
    }

    func send(text: String) -> Bool { enqueue(.string(text), size: text.utf8.count) }
    func send(data: Data) -> Bool { enqueue(.data(data), size: data.count) }

    private func enqueue(_ message: URLSessionWebSocketTask.Message, size: Int) -> Bool {
        guard let task, !finished else { return false }
        if pendingBytes + size > Self.maxBacklog { return false }
        pendingBytes += size
        task.send(message) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                self.pendingBytes = max(0, self.pendingBytes - size)
                if error != nil { self.fail() }
            }
        }
        return true
    }

    func close(graceful: Bool) {
        finished = true
        if graceful { task?.cancel(with: .normalClosure, reason: nil) } else { task?.cancel() }
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, !self.finished else { return }
                switch result {
                case .success(.string(let text)): self.onText?(text); self.receive()
                case .success(.data(let data)): self.onData?(data); self.receive()
                case .success: self.receive()
                case .failure: self.fail()
                }
            }
        }
    }

    private func fail() {
        guard !finished else { return }
        finished = true
        let status = (task?.response as? HTTPURLResponse)?.statusCode
        session?.invalidateAndCancel()
        onFailure?(status)
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated {
            guard !finished, webSocketTask === task else { return }
            onOpen?()
            receive()
        }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        MainActor.assumeIsolated {
            guard !finished, webSocketTask === task else { return }
            finished = true
            onClosed?()
        }
    }

    nonisolated func urlSession(_ session: URLSession, task completed: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            guard !finished, completed === task, error != nil else { return }
            fail()
        }
    }
}
