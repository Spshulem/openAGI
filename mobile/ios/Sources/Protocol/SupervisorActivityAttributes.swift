import ActivityKit
import Foundation

// The Live Activity's type, shared by the app (which reads its push-to-start
// token) and the widget extension (which draws it). The daemon starts it by
// push, so the type name and every field name are part of the wire contract:
// the relay sends `"attributes-type": "SupervisorActivityAttributes"`,
// `attributes: { slot: "fleet" }` and `content-state: { sealed }`. Renaming
// anything here silently breaks push-to-start.
//
// The content state is only ever ciphertext; the widget decrypts it with the
// push key at draw time. Its own file, not PushEnvelope.swift, so the
// notification service extension never links ActivityKit.
public struct SupervisorActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public var sealed: String

        public init(sealed: String) {
            self.sealed = sealed
        }
    }

    // Always "fleet": one activity per paired daemon.
    public var slot: String

    public init(slot: String = "fleet") {
        self.slot = slot
    }
}
