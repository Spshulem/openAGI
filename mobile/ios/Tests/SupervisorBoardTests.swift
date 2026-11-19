import Foundation
import SupervisorChannelsKit
import XCTest
@testable import OpenAGI

final class SupervisorBoardTests: XCTestCase {
    private struct TaskListEnvelope: Decodable {
        let tasks: [TaskRecord]
    }

    func testTasksListFixtureDecodesWithNilSourceMeta() throws {
        let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fixtureURL = testsDir
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("fixtures/tasks-list.json")
        let data = try Data(contentsOf: fixtureURL)
        let envelope = try ProtocolDecoder.json.decode(TaskListEnvelope.self, from: data)
        XCTAssertFalse(envelope.tasks.isEmpty)
        for task in envelope.tasks {
            XCTAssertNil(task.sourceMeta)
        }
    }

    func testTaskRecordRoundTripsBoardSourceMetaAndLease() throws {
        let json = #"""
        {
          "id": "task-board-1",
          "queue": "agent",
          "title": "Fix flaky Board inspector test",
          "description": "Ensure wide split view renders cleanly",
          "bucket": "today",
          "priority": 3,
          "category": "engineering",
          "tags": ["kind=bug", "pr=#309"],
          "source": "board",
          "sourceId": "paseo:host.t1",
          "sourceUrl": null,
          "sourceMeta": {
            "threadKey": "paseo:host.t1",
            "project": "openAGI",
            "subchannel": "ci",
            "actor": "codex · gpt-5.4 via Paseo",
            "blockedReason": "Waiting on CI run #42",
            "agentLease": {
              "claimedAt": "2026-11-19T10:00:00Z",
              "expiresAt": "2026-11-19T12:00:00Z",
              "attempts": 1
            }
          },
          "status": "in_progress",
          "createdAt": "2026-11-19T09:00:00Z",
          "updatedAt": "2026-11-19T10:00:00Z",
          "dueDate": null,
          "completedAt": null,
          "parentTaskId": null,
          "dependsOn": [],
          "isRecurring": false,
          "recurrenceRule": null
        }
        """#

        let decoded = try ProtocolDecoder.json.decode(TaskRecord.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.sourceMeta?.threadKey, "paseo:host.t1")
        XCTAssertEqual(decoded.sourceMeta?.project, "openAGI")
        XCTAssertEqual(decoded.sourceMeta?.subchannel, "ci")
        XCTAssertEqual(decoded.sourceMeta?.actor, "codex · gpt-5.4 via Paseo")
        XCTAssertEqual(decoded.sourceMeta?.blockedReason, "Waiting on CI run #42")
        XCTAssertEqual(decoded.sourceMeta?.agentLease?.claimedAt, "2026-11-19T10:00:00Z")
        XCTAssertEqual(decoded.sourceMeta?.agentLease?.expiresAt, "2026-11-19T12:00:00Z")
        XCTAssertEqual(decoded.sourceMeta?.agentLease?.attempts, 1)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try encoder.encode(decoded)
        let roundTripped = try ProtocolDecoder.json.decode(TaskRecord.self, from: encoded)
        XCTAssertEqual(roundTripped, decoded)
    }

    func testFleetStateDecodesBoardFieldsCardsThreadsActivityAndMessages() throws {
        let json = #"""
        {
          "mode": "propose",
          "enabled": true,
          "running": false,
          "nextTickAt": "2026-11-19T10:15:00Z",
          "snapshot": {
            "threads": [
              {
                "key": "codex:board-1",
                "title": "Board Inspector PR",
                "workspace": "openAGI",
                "state": "waiting",
                "health": "needs_human",
                "nextCheckAt": "2026-11-19T10:20:00Z",
                "actorLabel": "codex · gpt-5.4 via Paseo",
                "subchannel": "ios",
                "labels": ["kind=feature", "pr=#410"],
                "blockers": [],
                "live": true
              }
            ]
          },
          "cards": [
            {
              "id": "card-1",
              "kind": "question",
              "headline": "Approve migration before claim?",
              "blockingCount": 2,
              "blockingSummary": "Blocking 2 downstream tasks & PR #410",
              "actorLabel": "claude · sonnet-4.5 via Paseo",
              "subchannel": "backend",
              "labels": ["kind=decision", "ci=passing"],
              "suggestedReplies": [],
              "threadKeys": ["codex:board-1"]
            }
          ],
          "activityEvents": [
            {
              "id": "evt-1",
              "kind": "claim",
              "actor": "codex · gpt-5.4",
              "project": "openAGI",
              "subchannel": "ios",
              "title": "Claimed task in Paseo",
              "detail": "Started thread codex:board-1",
              "threadKey": "codex:board-1",
              "taskId": "task-1",
              "prRef": "owner/openAGI#410",
              "labels": ["state=running"],
              "at": "2026-11-19T10:05:00Z"
            }
          ]
        }
        """#

        let state = try ProtocolDecoder.json.decode(FleetState.self, from: Data(json.utf8))
        XCTAssertNotNil(state.nextTickAt)
        XCTAssertEqual(state.activityEvents.count, 1)
        XCTAssertEqual(state.activityEvents.first?.threadKey, "codex:board-1")
        XCTAssertEqual(state.activityEvents.first?.subchannel, "ios")
        XCTAssertEqual(state.activityEvents.first?.labels, ["state=running"])

        let thread = try XCTUnwrap(state.snapshot?.threads.first)
        XCTAssertNotNil(thread.nextCheckAt)
        XCTAssertEqual(thread.actorLabel, "codex · gpt-5.4 via Paseo")
        XCTAssertEqual(thread.subchannel, "ios")
        XCTAssertEqual(thread.labels, ["kind=feature", "pr=#410"])

        let card = try XCTUnwrap(state.cards.first)
        XCTAssertEqual(card.blockingCount, 2)
        XCTAssertEqual(card.blockingSummary, "Blocking 2 downstream tasks & PR #410")
        XCTAssertEqual(card.actorLabel, "claude · sonnet-4.5 via Paseo")
        XCTAssertEqual(card.subchannel, "backend")
        XCTAssertEqual(card.labels, ["kind=decision", "ci=passing"])

        let msgJSON = #"{"id":"m1","role":"assistant","text":"[progress] Built inspector","at":"2026-11-19T10:06:00Z","actor":"codex · gpt-5.4"}"#
        let msg = try ProtocolDecoder.json.decode(FleetConversationMessage.self, from: Data(msgJSON.utf8))
        XCTAssertEqual(msg.actor, "codex · gpt-5.4")
    }

    func testSupervisorChannelsKitBoardHelpers() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let activeLease = ISO8601DateFormatter().string(from: now.addingTimeInterval(600))
        let state = SupervisorBoardTaskClassifier.classify(
            status: "in_progress",
            queue: "agent",
            leaseExpiresAtISO: activeLease,
            now: now
        )
        XCTAssertEqual(state, .claimed)
        XCTAssertEqual(
            SupervisorBoardTaskClassifier.leaseBadgeText(expiresAtISO: activeLease, now: now),
            "Claimed · 10m left"
        )

        let tags = ["kind=bug", "pr=#309", "not-a-label", "KIND=bug"]
        let labels = SupervisorBoardLabel.extract(from: tags)
        XCTAssertEqual(labels.map(\.raw), ["kind=bug", "pr=#309"])
        XCTAssertTrue(SupervisorBoardLabel.matches(tags: tags, activeFilters: ["kind=bug"]))
        XCTAssertFalse(SupervisorBoardLabel.matches(tags: tags, activeFilters: ["state=running"]))

        let milestones = SupervisorMilestoneParser.parse(from: """
        - [decision] Ship 2-pane inspector on wide screens
        - [progress] Wired spencer/openAGI#309 and commit abc1234
        """)
        XCTAssertTrue(milestones.contains { $0.kind == .decision })
        XCTAssertTrue(milestones.contains { $0.kind == .progress })
        XCTAssertTrue(milestones.contains { $0.kind == .pr && $0.summary == "spencer/openAGI#309" })
        XCTAssertTrue(milestones.contains { $0.kind == .commit && $0.summary == "abc1234" })

        let checkBadge = SupervisorQuietCheckFormatter.badge(nextCheckDate: now.addingTimeInterval(180), now: now)
        XCTAssertEqual(checkBadge, "Next quiet check in 3m")

        let decisions = [
            SupervisorDecisionItem(id: "d1", project: "openAGI", subchannel: "openAGI/ci", headline: "PR check"),
            SupervisorDecisionItem(id: "d2", project: "openAGI", subchannel: "ios", headline: "Sign build")
        ]
        let sessions = [
            SupervisorSessionBrief(id: "s1", project: "openAGI", subchannel: "ci", title: "Runner", state: "running")
        ]
        let subs = SupervisorChannelGrouping.subchannels(forProject: "openAGI", from: decisions, sessions: sessions)
        XCTAssertEqual(subs.map(\.displayName).sorted(), ["/ci", "/ios"])
        XCTAssertEqual(subs.first(where: { $0.displayName == "/ci" })?.waitingCount, 1)
        XCTAssertEqual(subs.first(where: { $0.displayName == "/ci" })?.runningCount, 1)
    }

    func testFleetClaimTaskPostsExpectedPayload() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let client = DaemonClient(
            server: URL(string: "http://mac.tail1234.ts.net:43210")!,
            nodeID: "mobile:abc",
            token: String(repeating: "b", count: 43),
            session: URLSession(configuration: config)
        )
        StubProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data(#"{"session":{"key":"paseo:host.t9","title":"Run board tests","workspace":"openAGI","provider":"paseo","model":"gpt-5.4"}}"#.utf8)
            )
        }

        let response = try await client.fleetClaimTask(taskId: "t9", project: "openAGI")
        XCTAssertEqual(response.session?.key, "paseo:host.t9")
        let req = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/fleet/api/tasks/claim")
    }
}
