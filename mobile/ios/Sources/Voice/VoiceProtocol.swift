import Foundation

// The phone side of WSS /nodes/voice (src/voice/relay.js), ported from
// Android's VoiceSession.kt so both clients speak the same protocol. The hub
// owns the provider key, the Realtime session, the tools and every approval;
// the phone only streams audio and control frames.

// What the owner is looking at, sent on start and on context changes so the
// Supervisor can resolve "this" and "that" (voice_focus). Unset fields are
// omitted.
struct VoiceFocus: Codable, Equatable, Sendable {
    var view = "supervisor"
    var threadKey: String?
    var questionId: String?
    var actionId: String?
    var prRef: String?
    var fixId: String?
    var suggestionId: String?
}

enum VoiceFrames {
    static func start(handsFree: Bool, focus: VoiceFocus) -> String {
        encode(["type": "start", "gesture": "mic", "mode": handsFree ? "handsfree" : "ptt", "focus": focusObject(focus)])
    }

    static func context(_ focus: VoiceFocus) -> String {
        encode(["type": "context", "focus": focusObject(focus)])
    }

    static func control(_ type: String, playedMs: Int? = nil) -> String {
        var object: [String: Any] = ["type": type]
        if let playedMs { object["playedMs"] = max(0, playedMs) }
        return encode(object)
    }

    static func mode(handsFree: Bool) -> String {
        encode(["type": "mode", "handsFree": handsFree])
    }

    static func playback(itemId: String, playedMs: Double) -> String {
        encode(["type": "playback", "itemId": itemId, "playedMs": playedMs])
    }

    // A server frame as a dictionary; nil for anything that is not a JSON
    // object. Unknown frame types stay readable by their "type".
    static func decode(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object
    }

    // A scalar field as text, like Android's field(): nil for objects/arrays.
    static func field(_ frame: [String: Any], _ key: String) -> String? {
        switch frame[key] {
        case let value as String: return value
        case let value as NSNumber:
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return value.boolValue ? "true" : "false" }
            return value.stringValue
        default: return nil
        }
    }

    private static func focusObject(_ focus: VoiceFocus) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(focus),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["view": focus.view] }
        return object
    }

    private static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

enum VoicePhase: Equatable, Sendable { case idle, connecting, ready }
enum VoiceEffect: Equatable, Sendable { case startCapture, stopCapture, commit, cancel, barge }

// Push-to-talk versus hands-free, and when the microphone may run. A release
// while connecting must never turn the microphone on later.
struct VoiceStateMachine: Equatable {
    private(set) var phase: VoicePhase = .idle
    private(set) var handsFree = false
    private(set) var held = false
    private(set) var recording = false

    mutating func start(handsFree: Bool, held: Bool) {
        phase = .connecting
        self.handsFree = handsFree
        self.held = held
        recording = false
    }

    mutating func ready() -> [VoiceEffect] {
        guard phase == .connecting else { return [] }
        phase = .ready
        return reconcile()
    }

    mutating func press() -> [VoiceEffect] {
        if handsFree || held || phase == .idle { return [] }
        held = true
        return phase == .ready ? [.barge] + reconcile() : []
    }

    mutating func release(commit: Bool = true) -> [VoiceEffect] {
        let wasRecording = recording && !handsFree
        held = false
        return reconcile() + (wasRecording ? [commit ? .commit : .cancel] : [])
    }

    mutating func mode(_ on: Bool) -> [VoiceEffect] {
        handsFree = on
        held = false
        return reconcile()
    }

    mutating func stop() -> [VoiceEffect] {
        let effects: [VoiceEffect] = recording ? [.stopCapture] : []
        phase = .idle
        handsFree = false
        held = false
        recording = false
        return effects
    }

    private mutating func reconcile() -> [VoiceEffect] {
        let want = phase == .ready && (handsFree || held)
        if want == recording { return [] }
        recording = want
        return [want ? .startCapture : .stopCapture]
    }
}

struct VoiceStatus: Equatable, Sendable {
    var phase: VoicePhase = .idle
    var handsFree = false
    var recording = false
    // Reply audio is playing: "Speaking" in the UI.
    var speaking = false
    var ownerText = ""
    var replyText = ""
    var message: String?

    var isActive: Bool { phase != .idle }
}
