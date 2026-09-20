import XCTest
@testable import OpenAGI

// Pins ChatEvent.decode against the exact frame shapes
// `streamLocalMessage` (src/hosted-interface.js) writes for a streamed
// `POST /message` -- status/session/heartbeat/delta/final/failure -- since
// mobile/PROTOCOL.md documents `GET /events`'s framing but not this one.
final class ChatEventTests: XCTestCase {
    func testDecodesAStatusFrame() {
        let event = SSEEvent(name: "status", data: #"{"stage":"thinking","at":"2026-09-20T01:00:00.000Z","sessionId":"s1"}"#)
        guard case let .status(frame) = ChatEvent.decode(event) else { return XCTFail("expected .status") }
        XCTAssertEqual(frame.stage, "thinking")
        XCTAssertEqual(frame.sessionId, "s1")
    }

    func testDecodesASessionFrame() {
        let event = SSEEvent(name: "session", data: #"{"id":"sess_1","messageCount":3}"#)
        guard case let .session(frame) = ChatEvent.decode(event) else { return XCTFail("expected .session") }
        XCTAssertEqual(frame.id, "sess_1")
        XCTAssertEqual(frame.messageCount, 3)
    }

    func testDecodesADeltaFrameWithReset() {
        let event = SSEEvent(name: "delta", data: #"{"text":"Hello","reset":true,"at":"2026-09-20T01:00:00.000Z"}"#)
        guard case let .delta(frame) = ChatEvent.decode(event) else { return XCTFail("expected .delta") }
        XCTAssertEqual(frame.text, "Hello")
        XCTAssertTrue(frame.reset)
    }

    // `reset` defaults to a normal append when the daemon omits it -- a
    // missing key must not fail decoding.
    func testDeltaFrameDefaultsResetWhenAbsent() {
        let event = SSEEvent(name: "delta", data: #"{"text":"more","reset":false}"#)
        guard case let .delta(frame) = ChatEvent.decode(event) else { return XCTFail("expected .delta") }
        XCTAssertFalse(frame.reset)
    }

    func testDecodesTheFinalFrame() {
        let event = SSEEvent(name: "final", data: #"{"reply":"All done.","session":{"id":"sess_1","messageCount":4}}"#)
        guard case let .final(frame) = ChatEvent.decode(event) else { return XCTFail("expected .final") }
        XCTAssertEqual(frame.reply, "All done.")
        XCTAssertEqual(frame.session?.id, "sess_1")
    }

    func testDecodesTheFailureFrame() {
        let event = SSEEvent(name: "failure", data: #"{"code":"provider_error","error":"model unavailable","sessionId":"s1"}"#)
        guard case let .failure(frame) = ChatEvent.decode(event) else { return XCTFail("expected .failure") }
        XCTAssertEqual(frame.code, "provider_error")
        XCTAssertEqual(frame.error, "model unavailable")
    }

    // A heartbeat frame (or anything else this daemon might add later) is
    // deliberately not a case the chat UI needs to act on.
    func testHeartbeatAndUnknownFramesDecodeToNil() {
        XCTAssertNil(ChatEvent.decode(SSEEvent(name: "heartbeat", data: #"{"at":"x","stage":"y","sessionId":"s1"}"#)))
        XCTAssertNil(ChatEvent.decode(SSEEvent(name: "something-new", data: "{}")))
    }

    // Malformed JSON for a known event name must not crash -- it decodes to
    // nil rather than throwing out of a non-throwing function.
    func testMalformedDataDecodesToNilRatherThanCrashing() {
        XCTAssertNil(ChatEvent.decode(SSEEvent(name: "delta", data: "not json")))
    }
}
