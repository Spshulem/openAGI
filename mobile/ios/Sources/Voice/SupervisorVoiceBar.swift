import SwiftUI

// Voice Mode's control in the Supervisor chat: one tap starts a continuous
// spoken conversation, the state is always visible (Connecting, Listening,
// Speaking), and Stop is always one tap away while the mic can be live.
struct SupervisorVoiceBar: View {
    let status: VoiceStatus
    let note: String?
    let start: () -> Void
    let stop: () -> Void

    nonisolated static func stateLabel(_ status: VoiceStatus) -> String? {
        switch status.phase {
        case .idle: return nil
        case .connecting: return "Connecting…"
        case .ready:
            if status.speaking { return "Speaking" }
            if status.recording { return "Listening" }
            return "Voice on"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label = Self.stateLabel(status) {
                HStack(spacing: 10) {
                    Image(systemName: status.speaking ? "speaker.wave.2.fill" : (status.recording ? "mic.fill" : "waveform"))
                        .foregroundStyle(status.recording && !status.speaking ? Theme.alert : Theme.live)
                        .accessibilityHidden(true)
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("supervisor-voice-state")
                    Spacer(minLength: 0)
                    Button(role: .destructive, action: stop) {
                        Label("Stop", systemImage: "stop.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.alert)
                    .accessibilityLabel("Stop voice")
                    .accessibilityIdentifier("supervisor-voice-stop")
                }
                .accessibilityElement(children: .contain)
            } else {
                Button(action: start) {
                    Label("Talk with Supervisor", systemImage: "waveform")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .accessibilityHint("Starts a spoken conversation. Your words and replies are saved in this chat.")
                .accessibilityIdentifier("supervisor-voice-start")
            }
            if let message = status.message ?? note {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("supervisor-voice-message")
            }
        }
        .padding(.horizontal, 12)
    }
}
