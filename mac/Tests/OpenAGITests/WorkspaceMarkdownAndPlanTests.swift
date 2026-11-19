import XCTest
@testable import OpenAGI

final class WorkspaceMarkdownAndPlanTests: XCTestCase {
  func testParsesGfmTableBlockquoteAndThematicBreak() {
    let md = """
    Summary header:

    | Chat | What is unclear | My take |
    | --- | :--- | ---: |
    | Bob | Timing on retry \\| backoff | Cap at 60s |
    | Staging | Env var name | Keep `Staging` |

    > Note: approve after checking.

    ---

    Done.
    """

    let blocks = WorkspaceMarkdownParser.parse(md)
    XCTAssertEqual(blocks, [
      .paragraph("Summary header:"),
      .table(
        headers: ["Chat", "What is unclear", "My take"],
        rows: [
          ["Bob", "Timing on retry | backoff", "Cap at 60s"],
          ["Staging", "Env var name", "Keep `Staging`"]
        ]
      ),
      .blockquote("Note: approve after checking."),
      .thematicBreak,
      .paragraph("Done.")
    ])
  }

  func testDoesNotMisparseProseWithPipeAsTable() {
    let md = "Use flag A | B\nnext line"
    let blocks = WorkspaceMarkdownParser.parse(md)
    XCTAssertEqual(blocks, [.paragraph("Use flag A | B next line")])
  }

  func testDecodesSuggestionPlanAndClarificationMeta() throws {
    let json = #"""
    {
      "id": "fq_9b46bc5ae86c4941",
      "kind": "suggestion",
      "title": "Needs owner answer before acting",
      "body": "Two delivery retries stalled yesterday.",
      "options": ["Answer question", "Review plan", "Not now", "Never"],
      "threadKey": "paseo:srv_1.ag_1",
      "canReply": false,
      "meta": {
        "suggestionId": "sug_1",
        "plan": {
          "remedy": "clarification",
          "label": "Clarify retry backoff cap",
          "nextAction": "Should automated retries cap backoff at 60 seconds?",
          "acceptance": "Cap retry delay at 60s across hosted routes.",
          "issueDraft": {
            "title": "Cap delivery retry backoff",
            "body": "Limit exponential backoff."
          }
        },
        "clarification": {
          "answer": "Cap at 60s."
        }
      }
    }
    """#

    let question = try JSONDecoder().decode(FleetQuestion.self, from: Data(json.utf8))
    XCTAssertEqual(question.plan?.remedy, "clarification")
    XCTAssertEqual(question.plan?.label, "Clarify retry backoff cap")
    XCTAssertEqual(question.plan?.nextAction, "Should automated retries cap backoff at 60 seconds?")
    XCTAssertEqual(question.plan?.acceptance, "Cap retry delay at 60s across hosted routes.")
    XCTAssertEqual(question.plan?.issueDraft?.title, "Cap delivery retry backoff")
    XCTAssertEqual(question.clarificationAnswer, "Cap at 60s.")
    XCTAssertTrue(question.isClarificationQuestion)
    XCTAssertEqual(FleetReplyTarget.of(question), .question(id: "fq_9b46bc5ae86c4941"))
  }
}
