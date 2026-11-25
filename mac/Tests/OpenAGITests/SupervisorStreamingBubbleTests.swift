import XCTest
@testable import OpenAGI

/// One reply is one bubble: while it streams, through a transcript sync that
/// brings the server's saved copy, and with a follow-up queued behind it.
final class SupervisorStreamingBubbleTests: XCTestCase {
  private func message(_ id: String, _ role: String, _ text: String) -> SyncedSupervisorMessage {
    SyncedSupervisorMessage(id: id, role: role, text: text, at: nil, sourceName: nil, sourceNodeId: nil, attachments: nil)
  }

  private func live(_ streaming: String?, _ messages: [SyncedSupervisorMessage], _ baseline: Set<String>, _ prompt: String?) -> String? {
    SharedSupervisorClient.liveReplyText(streaming: streaming, messages: messages, baseline: baseline, prompt: prompt)
  }

  func testStreamedTextShowsUntilTheTranscriptHoldsThisReply() {
    let earlier = message("a1", "assistant", "Earlier answer.")
    let question = message("u1", "user", "What needs me?")
    // Streaming, nothing saved yet: the live text is the reply.
    XCTAssertEqual(live("Two threads", [earlier, question], ["a1"], "What needs me?"), "Two threads")
    // A sync mid-stream brought the saved, complete reply: draw it once.
    let saved = message("a2", "assistant", "Two threads need you: amman and cairo.")
    XCTAssertNil(live("Two threads", [earlier, question, saved], ["a1"], "What needs me?"))
    // Nothing streamed yet shows no live bubble.
    XCTAssertNil(live("   ", [earlier, question], ["a1"], "What needs me?"))
  }

  func testAQueuedFollowUpStartsFromTheFinishedReply() {
    let first = message("a2", "assistant", "Two threads need you.")
    let followUp = message("u2", "user", "Which first?")
    XCTAssertEqual(live("Amman", [first, followUp], ["a1", "a2"], "Which first?"), "Amman")
    XCTAssertNil(live("Amman", [first, followUp, message("a3", "assistant", "Amman first.")], ["a1", "a2"], "Which first?"))
  }

  func testAnswersToOtherQuestionsNeverHideTheStream() {
    let question = message("u1", "user", "What needs me?")
    // A Quick Ask mirrored in mid-stream: its own question and answer.
    let quickAsk = [message("u9", "user", "What time is it in Tokyo?"), message("a9", "assistant", "9 pm.")]
    XCTAssertEqual(live("Two threads", [question] + quickAsk, [], "What needs me?"), "Two threads")
    // Older history a sync brings back sits before this turn's question.
    XCTAssertEqual(live("Two threads", [message("a0", "assistant", "Older answer."), question], [], "What needs me?"), "Two threads")
    // This turn's question not in the transcript yet: keep streaming.
    XCTAssertEqual(live("Two threads", [message("a5", "assistant", "Other.")], [], "What needs me?"), "Two threads")
  }
}
