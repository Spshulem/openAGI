import XCTest
@testable import OpenAGI

/// One reply is one bubble: while it streams, through a transcript sync that
/// brings the server's saved copy, and with a follow-up queued behind it.
final class SupervisorStreamingBubbleTests: XCTestCase {
  private func message(_ id: String, _ role: String, _ text: String) -> SyncedSupervisorMessage {
    SyncedSupervisorMessage(id: id, role: role, text: text, at: nil, sourceName: nil, sourceNodeId: nil, attachments: nil)
  }

  func testStreamedTextShowsUntilTheTranscriptHoldsThisReply() {
    let earlier = message("a1", "assistant", "Earlier answer.")
    let question = message("local_u1", "user", "What needs me?")
    let baseline: Set<String> = ["a1"]
    // Streaming, nothing saved yet: the live text is the reply.
    XCTAssertEqual(SharedSupervisorClient.liveReplyText(streaming: "Two threads", messages: [earlier, question], baseline: baseline), "Two threads")
    // A sync mid-stream brought the saved, complete reply: draw it once.
    let saved = message("a2", "assistant", "Two threads need you: amman and cairo.")
    XCTAssertNil(SharedSupervisorClient.liveReplyText(streaming: "Two threads", messages: [earlier, question, saved], baseline: baseline))
    XCTAssertTrue(SharedSupervisorClient.replyAlreadyShown(messages: [earlier, question, saved], baseline: baseline))
    // Nothing streamed yet shows no live bubble.
    XCTAssertNil(SharedSupervisorClient.liveReplyText(streaming: "   ", messages: [earlier, question], baseline: baseline))
  }

  func testAQueuedFollowUpStartsFromTheFinishedReply() {
    // The first reply is in the transcript; the follow-up's turn takes it
    // as its baseline, so its own stream shows until its reply is saved.
    let first = message("a2", "assistant", "Two threads need you.")
    let followUp = message("local_u2", "user", "Which first?")
    let baseline: Set<String> = ["a1", "a2"]
    XCTAssertEqual(SharedSupervisorClient.liveReplyText(streaming: "Amman", messages: [first, followUp], baseline: baseline), "Amman")
    XCTAssertNil(SharedSupervisorClient.liveReplyText(streaming: "Amman", messages: [first, followUp, message("a3", "assistant", "Amman first.")], baseline: baseline))
    // An owner message from another device is not this reply.
    XCTAssertEqual(SharedSupervisorClient.liveReplyText(streaming: "Amman", messages: [first, followUp, message("u3", "user", "From the phone")], baseline: baseline), "Amman")
  }
}
