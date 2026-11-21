import AVFoundation

enum VoiceAudioError: Error { case unavailable }

// Microphone in and reply audio out for voice, on one AVAudioEngine with
// Apple's voice processing (echo cancellation), so hands-free mode does not
// hear its own replies. Wire format both ways: 24 kHz PCM16 mono, what the
// hub's Realtime session expects (src/voice/broker.js VOICE_RATE).
//
// Engine callbacks run on the audio thread. They are built in nonisolated
// helpers that capture only Sendable values and hop to the main actor, so
// Swift's isolation checks never see a main-actor closure off the main thread.
@MainActor
final class VoiceAudio: VoiceAudioIO {
    static let rate: Double = 24_000
    // Reply audio queued beyond this means playback fell behind.
    static let maxQueuedSeconds: Double = 60

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playbackFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    private let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
    private var opened = false
    private var capturing = false
    private var interruptionObserver: NSObjectProtocol?
    private var onInterrupted: (@MainActor () -> Void)?
    private var onAudio: (@MainActor (Data) -> Void)?
    // Player sample positions, for "how much of this reply was heard".
    private var scheduledEnd: AVAudioFramePosition = 0
    private var replyStart: AVAudioFramePosition?
    private var completions: [Int: @MainActor () -> Void] = [:]
    private var nextCompletion = 0

    init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
    }

    static func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func open(onInterrupted: @escaping @MainActor () -> Void) -> Bool {
        if opened { return true }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
            try session.setActive(true)
        } catch {
            return false
        }
        // Echo cancellation; unavailable on some simulators, where voice still works.
        try? engine.inputNode.setVoiceProcessingEnabled(true)
        engine.prepare()
        do { try engine.start() } catch {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            return false
        }
        player.play()
        scheduledEnd = 0
        replyStart = nil
        self.onInterrupted = onInterrupted
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main,
            using: Self.interruptionHandler(owner: self))
        opened = true
        return true
    }

    func startCapture(onAudio: @escaping @MainActor (Data) -> Void, onError: @escaping @MainActor () -> Void) throws {
        guard opened else { throw VoiceAudioError.unavailable }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let converter = AVAudioConverter(from: format, to: wireFormat) else { throw VoiceAudioError.unavailable }
        if capturing { input.removeTap(onBus: 0) }
        self.onAudio = onAudio
        let box = ConverterBox(converter: converter, output: wireFormat)
        input.installTap(onBus: 0, bufferSize: 2_400, format: format, block: Self.captureTap(box: box, owner: self))
        capturing = true
    }

    func stopCapture() {
        guard capturing else { return }
        engine.inputNode.removeTap(onBus: 0)
        capturing = false
        onAudio = nil
    }

    func play(_ pcm: Data, onError: @escaping @MainActor () -> Void) -> Bool {
        guard opened else { return false }
        let frames = pcm.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return false }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames { channel[index] = Float(Int16(littleEndian: samples[index])) / 32_768 }
        }
        let now = currentSample()
        if Double(scheduledEnd - now) / Self.rate > Self.maxQueuedSeconds { return false }
        let start = max(scheduledEnd, now)
        if replyStart == nil { replyStart = start }
        scheduledEnd = start + AVAudioFramePosition(frames)
        player.scheduleBuffer(buffer, completionHandler: nil)
        if !player.isPlaying { player.play() }
        return true
    }

    func completeReply(audioMs: Double, onPlayed: @escaping @MainActor () -> Void) {
        guard opened, let marker = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: 1) else { return }
        marker.frameLength = 1
        marker.floatChannelData?[0][0] = 0
        nextCompletion += 1
        let id = nextCompletion
        completions[id] = onPlayed
        scheduledEnd = max(scheduledEnd, currentSample()) + 1
        replyStart = nil
        player.scheduleBuffer(marker, completionCallbackType: .dataPlayedBack,
                              completionHandler: Self.playedHandler(id: id, owner: self))
        if !player.isPlaying { player.play() }
    }

    func barge() -> Int {
        guard opened else { return 0 }
        let heard = replyStart.map { max(0, currentSample() - $0) } ?? 0
        completions.removeAll()
        player.stop()
        player.play()
        scheduledEnd = 0
        replyStart = nil
        return Int(Double(heard) / Self.rate * 1_000)
    }

    func close() {
        stopCapture()
        completions.removeAll()
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        onInterrupted = nil
        guard opened else { return }
        player.stop()
        engine.stop()
        opened = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func currentSample() -> AVAudioFramePosition {
        guard let nodeTime = player.lastRenderTime, let time = player.playerTime(forNodeTime: nodeTime) else { return 0 }
        return time.sampleTime
    }

    fileprivate func deliver(_ pcm: Data) { onAudio?(pcm) }
    fileprivate func played(_ id: Int) { completions.removeValue(forKey: id)?() }
    fileprivate func interrupted() {
        let callback = onInterrupted
        close()
        callback?()
    }

    // MARK: - Audio-thread callbacks

    private nonisolated static func captureTap(box: ConverterBox, owner: VoiceAudio) -> AVAudioNodeTapBlock {
        let weakOwner = WeakAudio(owner)
        return { buffer, _ in
            guard let pcm = box.convert(buffer) else { return }
            Task { @MainActor in weakOwner.value?.deliver(pcm) }
        }
    }

    private nonisolated static func playedHandler(id: Int, owner: VoiceAudio) -> @Sendable (AVAudioPlayerNodeCompletionCallbackType) -> Void {
        let weakOwner = WeakAudio(owner)
        return { _ in Task { @MainActor in weakOwner.value?.played(id) } }
    }

    private nonisolated static func interruptionHandler(owner: VoiceAudio) -> @Sendable (Notification) -> Void {
        let weakOwner = WeakAudio(owner)
        return { note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in weakOwner.value?.interrupted() }
        }
    }
}

private final class WeakAudio: @unchecked Sendable {
    weak var value: VoiceAudio?
    init(_ value: VoiceAudio) { self.value = value }
}

// The microphone's native format to 24 kHz PCM16 mono. Used only from the
// engine's tap thread, one buffer at a time.
private final class ConverterBox: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let output: AVAudioFormat

    init(converter: AVAudioConverter, output: AVAudioFormat) {
        self.converter = converter
        self.output = output
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }
}
