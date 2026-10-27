import Foundation
import Observation
@preconcurrency import AVFoundation
@preconcurrency import Speech

// Only records after the microphone is tapped. Audio stays in Apple's on-device
// recognizer; dictation edits a draft and never submits it automatically.
@MainActor @Observable
final class ChatDictation {
    private(set) var isListening = false
    private(set) var isStarting = false
    private(set) var error: String?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var updateDraft: ((String) -> Void)?
    @ObservationIgnored private var ownsAudioSession = false
    @ObservationIgnored private var hasInputTap = false

    func start(draft: String, update: @escaping (String) -> Void) async {
        guard !isListening, !isStarting else { return }
        let generation = UUID()
        self.generation = generation
        isStarting = true
        error = nil
        defer { if self.generation == generation { isStarting = false } }
        guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.supportsOnDeviceRecognition else {
            error = "On-device dictation isn't available for this language. Try the microphone on the iOS keyboard."
            return
        }
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard self.generation == generation else { return }
        guard authorization == .authorized else {
            error = "Allow Speech Recognition for OpenAGI in iPhone Settings to dictate."
            return
        }
        let permitted = await AVAudioApplication.requestRecordPermission()
        guard self.generation == generation else { return }
        guard permitted else {
            error = "Allow microphone access for OpenAGI in iPhone Settings to dictate."
            return
        }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true)
            ownsAudioSession = true
            let engine = AVAudioEngine()
            self.engine = engine
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            self.request = request
            self.updateDraft = update
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NSError(domain: "Dictation", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable buffer, _ in request.append(buffer) }
            hasInputTap = true
            task = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, failure in
                let text = result?.bestTranscription.formattedString
                let finished = result?.isFinal == true
                let failed = failure != nil
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation else { return }
                    if let text { self.updateDraft?(Self.merging(draft: draft, transcript: text)) }
                    if failed || finished {
                        self.stop()
                        if failed && text == nil { self.error = "Dictation stopped. Your draft is saved; tap the microphone to try again." }
                    }
                }
            }
            engine.prepare()
            try engine.start()
            isListening = true
        } catch {
            stop()
            self.error = "Couldn't start dictation. Check microphone access and try again."
        }
    }

    func stop() {
        generation = UUID()
        isStarting = false
        updateDraft = nil
        if let engine {
            engine.stop()
            if hasInputTap { engine.inputNode.removeTap(onBus: 0) }
        }
        engine = nil
        hasInputTap = false
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        if ownsAudioSession { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        ownsAudioSession = false
        isListening = false
    }

    static func merging(draft: String, transcript: String) -> String {
        guard !draft.isEmpty, !transcript.isEmpty else { return draft + transcript }
        return draft + (draft.last?.isWhitespace == true ? "" : " ") + transcript
    }
}
