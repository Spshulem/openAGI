import SwiftUI

struct VoiceButton: View {
  @ObservedObject var voice = VoiceSession.shared
  @ObservedObject var overlay = OverlayState.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Button {
          if voice.micHeld { voice.release(.mic) }
          else { overlay.beginVoice(.mic) }
        } label: {
          Label(voice.micHeld ? "Send" : "Talk", systemImage: voice.recording ? "stop.circle.fill" : "mic.fill")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(voice.phase == .connecting)
        .help("Talk to the hub Supervisor. Hold Option-Shift-Space to talk, then release to send.")
        .accessibilityLabel(voice.micHeld ? "Send to Supervisor" : "Talk with Supervisor")
        .accessibilityValue(status)
        Text(status).font(.system(size: 10)).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        if voice.active {
          Button("End") { voice.stop() }
            .buttonStyle(.borderless).font(.system(size: 10))
            .help("End voice and stop the microphone")
            .accessibilityLabel("Stop voice")
        }
      }
      if !voice.transcript.isEmpty {
        Text("You: \(voice.transcript)").font(.system(size: 11)).lineLimit(4).textSelection(.enabled)
      }
      if !voice.reply.isEmpty {
        Text(voice.reply).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(6).textSelection(.enabled)
      }
      if let message = voice.error ?? voice.notice {
        Text(message).font(.system(size: 10)).foregroundStyle(voice.error == nil ? Color.secondary : .red).lineLimit(4)
      }
      if voice.error != nil {
        Text(VoiceSession.textFallbackNote).font(.system(size: 10)).foregroundStyle(.secondary)
      }
      if !voice.transcript.isEmpty || !voice.reply.isEmpty {
        Text("Voice uses the hub's shared Supervisor thread.")
          .font(.system(size: 9)).foregroundStyle(.tertiary)
      }
    }
  }

  private var status: String {
    switch voice.phase {
    case .idle: return "Voice Supervisor"
    case .connecting: return "Connecting…"
    case .ready: return "Ready"
    case .recording: return "Listening…"
    case .waiting: return "Thinking…"
    case .replying: return "Speaking…"
    }
  }
}
