import XCTest
@testable import OpenAGI

// No committed fixture exists for `/tasks/clarifications` (mobile/fixtures/
// only covers summary, tasks, pending-actions, enroll-exchange) -- this
// pins the shape directly against src/clarification-store.js's documented
// schema instead: `{ id, taskId, question, context, proposedAction,
// confidence, sources[], status, answer?, answeredAt?, createdAt }`.
final class ClarificationDecodingTests: XCTestCase {
    func testDecodesAPendingClarification() throws {
        let json = """
        {
          "id": "clar_abc123",
          "taskId": "task_5701146fe8184bfa",
          "question": "Did you finish shipping the widget?",
          "context": "No activity for 6 days",
          "proposedAction": "complete",
          "confidence": 0.62,
          "sources": ["calendar", "git"],
          "status": "pending",
          "answer": null,
          "answeredAt": null,
          "createdAt": "2026-09-20T01:40:25.625Z"
        }
        """
        let clarification = try ProtocolDecoder.json.decode(Clarification.self, from: Data(json.utf8))
        XCTAssertEqual(clarification.taskId, "task_5701146fe8184bfa")
        XCTAssertEqual(clarification.status, "pending")
        XCTAssertNil(clarification.answer)
        XCTAssertEqual(clarification.sources, ["calendar", "git"])
    }

    func testDecodesTheAnswerResponseWithATask() throws {
        let json = """
        {
          "clarification": {
            "id": "clar_abc123", "taskId": "task_1", "question": "Done?", "context": "",
            "proposedAction": "complete", "confidence": null, "sources": [],
            "status": "answered", "answer": "yes", "answeredAt": "2026-09-20T01:40:25.625Z",
            "createdAt": "2026-09-20T01:00:00.000Z"
          },
          "task": {
            "id": "task_1", "queue": "user", "title": "Ship the widget", "description": "",
            "bucket": "done", "priority": 50, "category": null, "tags": [], "source": "manual",
            "sourceId": null, "sourceUrl": null, "status": "completed", "dueDate": null,
            "scheduledFor": null, "parentGoalId": null, "dependsOn": [],
            "createdAt": "2026-09-20T01:00:00.000Z", "updatedAt": "2026-09-20T01:40:25.625Z",
            "completedAt": "2026-09-20T01:40:25.625Z", "completedVia": "mobile"
          }
        }
        """
        let response = try ProtocolDecoder.json.decode(ClarificationAnswerResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.clarification.answer, "yes")
        XCTAssertEqual(response.task?.status, "completed")
    }

    // Whole-branch review / source-of-truth finding: mobile/FEATURES.md
    // describes this as "a free-text answer", but
    // src/clarification-store.js's `ClarificationStore.answer` only accepts
    // one of these four values and 400s on anything else -- this pins the
    // client's enum against the daemon's actual contract.
    func testClarificationAnswerRawValuesMatchTheDaemonsValidAnswers() {
        let wireValues = Set(ClarificationAnswer.allCases.map(\.rawValue))
        XCTAssertEqual(wireValues, ["yes", "in_progress", "no", "dropped"])
    }
}
