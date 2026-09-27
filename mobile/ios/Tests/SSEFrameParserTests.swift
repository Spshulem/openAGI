import XCTest
@testable import OpenAGI

// mobile/PROTOCOL.md §7's exact wire format: `event: <name>\ndata:
// <json>\n\n`, a `: ping` comment every 15s that must be ignored, and an
// immediate `event: hello` frame. Pure and synchronous by design -- no
// URLSession, no daemon, no async -- so the framing itself is pinned
// directly against a fixed string, per the task brief's own suggestion.
final class SSEFrameParserTests: XCTestCase {
    private func parse(_ raw: String) -> [SSEEvent] {
        var parser = SSEFrameParser()
        var events: [SSEEvent] = []
        for line in raw.components(separatedBy: "\n") {
            if let event = parser.feed(line) { events.append(event) }
        }
        return events
    }

    func testParsesTheHelloFrame() {
        let events = parse("event: hello\ndata: {\"at\":\"2026-09-20T01:00:00.000Z\"}\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].name, "hello")
        XCTAssertTrue(events[0].data.contains("2026-09-20"))
    }

    func testIgnoresCommentPingLines() {
        let events = parse("event: hello\ndata: {}\n\n: ping\n\n")
        // Only the named frame counts -- the bare comment line produces no event.
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].name, "hello")
    }

    func testParsesMultipleFramesInOneFeed() {
        let raw = "event: task-updated\ndata: {\"op\":\"create\"}\n\nevent: pending-action\ndata: {\"id\":\"act_1\"}\n\n"
        let events = parse(raw)
        XCTAssertEqual(events.map(\.name), ["task-updated", "pending-action"])
    }

    // A frame with no `event:` line defaults to "message" per the SSE spec,
    // even though this daemon always names its events explicitly.
    func testMissingEventNameDefaultsToMessage() {
        let events = parse("data: {\"x\":1}\n\n")
        XCTAssertEqual(events.first?.name, "message")
    }

    // Multiple `data:` lines within one frame join with "\n" per the SSE
    // spec -- not exercised by this daemon today, but the parser must not
    // silently drop all but the last one if it ever is.
    func testMultipleDataLinesJoinWithNewline() {
        let events = parse("event: delta\ndata: line one\ndata: line two\n\n")
        XCTAssertEqual(events.first?.data, "line one\nline two")
    }

    func testAnUnterminatedFrameEmitsNothing() {
        // No trailing blank line: the frame never completes.
        XCTAssertTrue(parse("event: hello\ndata: {}").isEmpty)
    }

    func testDaemonEventMapsEveryNamedEventFromPROTOCOLSection7() {
        XCTAssertEqual(DaemonEvent.from(name: "hello"), .hello)
        XCTAssertEqual(DaemonEvent.from(name: "task-updated"), .taskUpdated)
        XCTAssertEqual(DaemonEvent.from(name: "task-reminder"), .taskReminder)
        XCTAssertEqual(DaemonEvent.from(name: "task-auto-changed"), .taskAutoChanged)
        XCTAssertEqual(DaemonEvent.from(name: "pending-action"), .pendingAction)
        XCTAssertEqual(DaemonEvent.from(name: "pending-action-resolved"), .pendingActionResolved)
        XCTAssertEqual(DaemonEvent.from(name: "clarification-created"), .clarificationCreated)
        XCTAssertEqual(DaemonEvent.from(name: "something-new"), .unknown(name: "something-new"))
    }
}
