import XCTest
@testable import OpenAGI
import SupervisorChannelsKit

final class SupervisorBoardTests: XCTestCase {
  func testTaskClassifierAndLeaseCountdown() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let iso = ISO8601DateFormatter()
    let liveExpires = iso.string(from: now.addingTimeInterval(24 * 60))
    let staleExpires = iso.string(from: now.addingTimeInterval(-120))

    XCTAssertEqual(
      SupervisorBoardTaskClassifier.classify(status: "pending", queue: "agent", hasOpenQuestion: true, now: now),
      .blocked
    )
    XCTAssertEqual(
      SupervisorBoardTaskClassifier.classify(status: "in_progress", queue: "agent", leaseExpiresAtISO: liveExpires, now: now),
      .claimed
    )
    XCTAssertEqual(
      SupervisorBoardTaskClassifier.leaseBadgeText(expiresAtISO: liveExpires, now: now),
      "Claimed · 24m left"
    )
    XCTAssertEqual(
      SupervisorBoardTaskClassifier.leaseBadgeText(expiresAtISO: staleExpires, now: now),
      "Lease expired"
    )
    XCTAssertEqual(
      SupervisorBoardTaskClassifier.classify(status: "completed", queue: "user", now: now),
      .done
    )
  }

  func testBoardLabelsParseAndMatch() {
    let labels = SupervisorBoardLabel.extract(from: ["kind=bug", "not-a-kv", "step=review", "KIND=bug"])
    XCTAssertEqual(labels.map(\.raw), ["kind=bug", "step=review"])
    XCTAssertTrue(SupervisorBoardLabel.matches(tags: ["kind=bug", "step=review"], activeFilters: ["step=review"]))
    XCTAssertFalse(SupervisorBoardLabel.matches(tags: ["kind=bug"], activeFilters: ["step=review"]))
  }

  func testSubchannelGroupingAndFiltering() {
    let decisions = [
      SupervisorDecisionItem(id: "q1", project: "openAGI", subchannel: "openagi/ios", headline: "Approve 2134"),
      SupervisorDecisionItem(id: "q2", project: "openAGI", subchannel: nil, headline: "Top level")
    ]
    let sessions = [
      SupervisorSessionBrief(id: "s1", project: "openAGI", subchannel: "openagi/ios", title: "iOS Board", state: "running"),
      SupervisorSessionBrief(id: "s2", project: "openAGI", subchannel: "openagi/mac", title: "Mac Inspector", state: "idle")
    ]
    let subs = SupervisorChannelGrouping.subchannels(forProject: "openAGI", from: decisions, sessions: sessions)
    XCTAssertEqual(subs.map(\.displayName), ["/ios", "/mac"])
    XCTAssertEqual(subs.first?.waitingCount, 1)
    XCTAssertEqual(
      SupervisorChannelGrouping.filterSessions(sessions, project: "openAGI", subchannel: "openagi/mac").map(\.id),
      ["s2"]
    )
  }

  func testMilestoneParserAndQuietCheckFormatter() {
    let text = """
    [decision] Store Board metadata inside sourceMeta
    - [progress] Wired POST /fleet/api/tasks/claim in routes.js
    Opened Spshulem/openAGI#309 and pushed commit `0efaf71` for review.
    """
    let items = SupervisorMilestoneParser.parse(from: text)
    XCTAssertEqual(items.map(\.kind), [.decision, .progress, .pr, .commit])
    XCTAssertEqual(items[2].ref, "Spshulem/openAGI#309")
    XCTAssertEqual(items[3].ref, "0efaf71")

    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let iso = ISO8601DateFormatter()
    XCTAssertEqual(
      SupervisorQuietCheckFormatter.badge(nextCheckISO: iso.string(from: now.addingTimeInterval(180)), now: now),
      "Next quiet check in 3m"
    )
  }

  func testFleetStateAndTaskItemDecodeNewBoardFields() throws {
    let fleetJSON = """
    {
      "mode": "propose",
      "enabled": true,
      "running": false,
      "lastTickAt": "2026-11-19T14:58:00.000Z",
      "nextTickAt": "2026-11-19T15:01:00.000Z",
      "questions": [
        {
          "id": "q1",
          "kind": "agent-ask",
          "title": "Approve release?",
          "body": "",
          "options": ["yes", "no"],
          "threadKey": "paseo:local:a1",
          "blockingCount": 2,
          "blockingSummary": "Blocking 2 downstream items",
          "actorLabel": "codex · gpt-5.4 via Paseo",
          "subchannel": "openagi/mac",
          "labels": ["state=waiting", "pr=#309"]
        }
      ],
      "snapshot": {
        "threads": [
          {
            "key": "paseo:local:a1",
            "title": "Inspector work",
            "state": "running",
            "actorLabel": "codex · gpt-5.4 via Paseo",
            "subchannel": "openagi/mac",
            "nextCheckAt": "2026-11-19T15:01:00.000Z",
            "labels": ["state=running", "pr=#309"]
          }
        ]
      },
      "activityEvents": [
        {
          "id": "act:1",
          "kind": "task_claimed",
          "actor": "codex · gpt-5.4 via Paseo",
          "project": "openAGI",
          "subchannel": "openagi/mac",
          "title": "Claimed: Build Inspector",
          "detail": "Active lease attached",
          "threadKey": "paseo:local:a1",
          "at": "2026-11-19T15:00:00.000Z"
        }
      ]
    }
    """
    let state = try JSONDecoder().decode(FleetState.self, from: Data(fleetJSON.utf8))
    XCTAssertEqual(state.nextTickAt, "2026-11-19T15:01:00.000Z")
    XCTAssertEqual(state.questions.first?.blockingCount, 2)
    XCTAssertEqual(state.questions.first?.actorLabel, "codex · gpt-5.4 via Paseo")
    XCTAssertEqual(state.threads.first?.nextCheckAt, "2026-11-19T15:01:00.000Z")
    XCTAssertEqual(state.activityEvents.first?.kind, "task_claimed")

    let taskJSON = """
    {
      "id": "task_1",
      "queue": "agent",
      "title": "Build Inspector",
      "status": "in_progress",
      "tags": ["kind=feature"],
      "dependsOn": ["task_0"],
      "sourceMeta": {
        "threadKey": "paseo:local:a1",
        "project": "openAGI",
        "subchannel": "mac",
        "actor": "codex · gpt-5.4",
        "agentLease": { "claimedAt": "2026-11-19T15:00:00Z", "expiresAt": "2026-11-19T15:30:00Z", "attempts": 1 }
      }
    }
    """
    let task = try JSONDecoder().decode(MacTaskItem.self, from: Data(taskJSON.utf8))
    XCTAssertEqual(task.sourceMeta?.threadKey, "paseo:local:a1")
    XCTAssertEqual(task.sourceMeta?.agentLease?.attempts, 1)
    XCTAssertEqual(task.dependsOn, ["task_0"])
  }
}
