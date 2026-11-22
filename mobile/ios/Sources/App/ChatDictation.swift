import Foundation
import Observation
@preconcurrency import AVFoundation
@preconcurrency import Speech
import os

// What dictation has heard this session, kept apart from the draft it began
// with. iOS finalizes a segment after a short pause (isFinal) and the next
// utterance starts a fresh transcript, so the draft is always: the original
// draft, every finalized segment, then the one still being spoken. A later
// segment can never replace text heard before it.
struct DictationTranscript: Equatable {
    let base: String
    private(set) var finished: [String] = []
    private(set) var live = ""

    init(base: String) { self.base = base }

    var draft: String {
        let heard = (finished + [live]).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
        return ChatDictation.merging(draft: base, transcript: heard)
    }

    // startsNewUtterance: the recognizer began a new utterance without first
    // marking the last one final; keep what was heard rather than drop it.
    // Whether a result begins a new utterance the recognizer did not mark
    // final. Only real, advancing timing counts: on-device partial results
    // often carry zero timestamps and durations, and an ordinary revision
    // ("Before" -> "Before the") must never be taken for a new utterance.
    // Segments are (start, end) in seconds; previousEnd is where the last
    // result's speech ended.
    static let utteranceGap: TimeInterval = 0.3
    nonisolated static func startsNewUtterance(previousEnd: TimeInterval?, segments: [(TimeInterval, TimeInterval)],
                                               live: String, text: String) -> Bool {
        guard let previousEnd, previousEnd > 0, let first = segments.first,
              first.0 > 0, first.1 > first.0 else { return false }
        guard first.0 >= previousEnd + utteranceGap else { return false }
        // Only text that extends everything already live is a continuation;
        // two utterances may share a first word ("I need milk", "I also need
        // bread"), and the timing above is what separates them.
        let normalize = { (value: String) in value.lowercased().filter { $0.isLetter || $0.isNumber || $0 == " " }
            .split(separator: " ").joined(separator: " ") }
        let liveText = normalize(live)
        return liveText.isEmpty || !normalize(text).hasPrefix(liveText)
    }

    // The end of the speech in a result, if its timing is set.
    nonisolated static func speechEnd(of segments: [(TimeInterval, TimeInterval)]) -> TimeInterval? {
        guard let end = segments.last?.1, end > 0 else { return nil }
        return end
    }

    // The request failed (after a long silence iOS reports "no speech"): keep
    // what it heard; the next request starts a fresh segment.
    mutating func endSegment() -> String {
        if !live.isEmpty { finished.append(live); live = "" }
        return draft
    }

    mutating func receive(_ text: String, isFinal: Bool, startsNewUtterance: Bool = false) -> String {
        if startsNewUtterance, !live.isEmpty { finished.append(live); live = "" }
        live = text
        if isFinal { finished.append(live); live = "" }
        return draft
    }
}

// The request the microphone tap feeds. A finalized segment swaps in a new
// request; the tap (on the audio thread) always appends to the current one.
final class DictationRequestBox: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<SFSpeechAudioBufferRecognitionRequest?>(initialState: nil)
    func set(_ request: SFSpeechAudioBufferRecognitionRequest?) { lock.withLock { $0 = request } }
    func append(_ buffer: AVAudioPCMBuffer) { lock.withLock { $0?.append(buffer) } }
}

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
    @ObservationIgnored private var transcript = DictationTranscript(base: "")
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private let requestBox = DictationRequestBox()
    @ObservationIgnored private var lastSegmentEnd: TimeInterval?
    // The recognition request whose results count; a finalized segment or a
    // new session replaces it, and late results from the old one are ignored.
    @ObservationIgnored private var recognitionID = UUID()
    @ObservationIgnored private var requestStartedAt = Date()
    @ObservationIgnored private var quickFailures = 0

    func start(draft: String, update: @escaping (String) -> Void) async {
        guard !isListening, !isStarting else { return }
        let generation = UUID()
        self.generation = generation
        isStarting = true
        error = nil
        defer { if self.generation == generation { isStarting = false } }
        transcript = DictationTranscript(base: draft)
        lastSegmentEnd = nil
        requestStartedAt = Date()
        quickFailures = 0
        #if DEBUG
        // The owner's report: dictate, pause about a second (iOS marks that
        // segment final), then keep talking. Replayed through the same
        // result handling the real recognizer uses.
        if UITestProtocol.isEnabled && ProcessInfo.processInfo.arguments.contains("--ui-dictation-pause-fixture") {
            self.updateDraft = update
            isListening = true
            // With --ui-dictation-silence, a long silence follows: the waiting
            // request fails with no text ("no speech"), then speech resumes.
            let silence = ProcessInfo.processInfo.arguments.contains("--ui-dictation-silence")
            Task {
                var script: [(String?, Bool, Bool, Int)] = [
                    ("Before the pause", false, false, 200), ("Before the pause.", true, false, 200),
                    ("After", false, false, 1200), ("After the pause it continues.", false, false, 200)
                ]
                if silence { script += [(nil, false, true, 2500), ("Still here.", false, false, 300)] }
                for (text, isFinal, failed, delay) in script {
                    try? await Task.sleep(for: .milliseconds(delay))
                    handle(text: text, isFinal: isFinal, failed: failed, generation: generation)
                }
            }
            return
        }
        if UITestProtocol.isEnabled && ProcessInfo.processInfo.arguments.contains("--ui-dictation-fixture") {
            self.updateDraft = update
            isListening = true
            Task {
                for text in ["A partial synthetic sentence.", UITestProtocol.dictationTranscript] {
                    try? await Task.sleep(for: .milliseconds(200))
                    receive(transcript: text, draft: draft, generation: generation)
                }
            }
            return
        }
        #endif
        guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.supportsOnDeviceRecognition else {
            error = "On-device dictation isn't available for this language. Try the microphone on the iOS keyboard."
            return
        }
        let authorization = await Self.speechAuthorization()
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
            self.recognizer = recognizer
            self.updateDraft = update
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NSError(domain: "Dictation", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
            }
            let box = requestBox
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable buffer, _ in box.append(buffer) }
            hasInputTap = true
            beginRecognition(generation: generation)
            engine.prepare()
            try engine.start()
            isListening = true
        } catch {
            stop()
            self.error = "Couldn't start dictation. Check microphone access and try again."
        }
    }

    // One recognition request on the running microphone. A finalized segment
    // starts the next one; the microphone and audio session stay on.
    private func beginRecognition(generation: UUID) {
        requestStartedAt = Date()
        guard let recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        self.request = request
        requestBox.set(request)
        lastSegmentEnd = nil
        let recognitionID = UUID()
        self.recognitionID = recognitionID
        task = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, failure in
            let text = result?.bestTranscription.formattedString
            let finished = result?.isFinal == true
            let failed = failure != nil
            let segments = result?.bestTranscription.segments.map { ($0.timestamp, $0.timestamp + $0.duration) } ?? []
            Task { @MainActor [weak self] in
                // Before touching any state, timing included: a late result from
                // a stopped session or a replaced request must change nothing.
                guard let self, self.generation == generation, self.recognitionID == recognitionID else { return }
                // A result that begins after everything heard so far ended is a
                // new utterance, even if iOS did not mark the last one final.
                let newUtterance = DictationTranscript.startsNewUtterance(
                    previousEnd: self.lastSegmentEnd, segments: segments, live: self.transcript.live, text: text ?? "")
                if let end = DictationTranscript.speechEnd(of: segments) { self.lastSegmentEnd = end }
                self.handle(text: text, isFinal: finished, failed: failed, startsNewUtterance: newUtterance, generation: generation)
            }
        }
    }

    // One recognizer result, real or replayed by a UI test fixture. A pause
    // finalizes a segment; that is never the end of dictation: only Stop (or
    // a real failure) ends it, and nothing is ever sent automatically.
    private func handle(text: String?, isFinal: Bool, failed: Bool, startsNewUtterance: Bool = false, generation: UUID) {
        guard self.generation == generation else { return }
        if let text {
            updateDraft?(transcript.receive(text, isFinal: isFinal, startsNewUtterance: startsNewUtterance))
            if !text.isEmpty { quickFailures = 0 }
        }
        if failed {
            let decision = Self.failureEndsDictation(listenedFor: Date().timeIntervalSince(requestStartedAt),
                                                     quickFailures: quickFailures,
                                                     microphoneRunning: engine.map { $0.isRunning } ?? true)
            quickFailures = decision.quickFailures
            if decision.ends {
                stop()
                error = "Dictation stopped. Your draft is saved; tap the microphone to try again."
                return
            }
            updateDraft?(transcript.endSegment())
            task = nil
            request = nil
            beginRecognition(generation: generation)
        } else if isFinal {
            task = nil
            request = nil
            beginRecognition(generation: generation)
        }
    }

    private func receive(transcript: String, draft: String, generation: UUID) {
        guard self.generation == generation else { return }
        updateDraft?(Self.merging(draft: draft, transcript: transcript))
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
        requestBox.set(nil)
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        recognizer = nil
        if ownsAudioSession { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        ownsAudioSession = false
        isListening = false
    }

    // A failed request after a long silence ("no speech") is replaced on the
    // running microphone. Dictation ends only if the microphone stopped or
    // requests keep failing as soon as they start.
    nonisolated static let quickFailure: TimeInterval = 1.5
    nonisolated static let quickFailureLimit = 3
    nonisolated static func failureEndsDictation(listenedFor elapsed: TimeInterval, quickFailures: Int,
                                                 microphoneRunning: Bool) -> (ends: Bool, quickFailures: Int) {
        let count = elapsed < quickFailure ? quickFailures + 1 : 0
        return (!microphoneRunning || count >= quickFailureLimit, count)
    }

    nonisolated static func merging(draft: String, transcript: String) -> String {
        guard !draft.isEmpty, !transcript.isEmpty else { return draft + transcript }
        return draft + (draft.last?.isWhitespace == true ? "" : " ") + transcript
    }

    // TCC calls back on a background queue. An implicitly MainActor-isolated
    // callback traps under Swift 6 before it can resume the continuation.
    static func speechAuthorization(
        request: (@escaping @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void) -> Void = {
            SFSpeechRecognizer.requestAuthorization($0)
        }
    ) async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            request { @Sendable status in continuation.resume(returning: status) }
        }
    }
}
