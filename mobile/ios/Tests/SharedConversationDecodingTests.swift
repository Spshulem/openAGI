import XCTest
@testable import OpenAGI

// The JSON shapes this phase added, decoded exactly as the daemon sends them
// (/tmp/shared-contract.md): the shared thread's history page, lifelog
// moments, the fleet supervisor's state, and the `conversation.updated`
// event. Each one also pins the lenient half of the contract -- a null, a
// missing field, or one malformed element degrades, never throws.
final class SharedConversationDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try ProtocolDecoder.json.decode(type, from: Data(json.utf8))
    }

    // MARK: - GET /conversations/:thread/messages

    func testConversationPageDecodesMessagesOldestFirst() throws {
        let page = try decode(ConversationPage.self, """
        {"thread":"agent","messages":[
          {"id":"m1","role":"user","text":"What's on today?","at":"2026-09-28T15:40:00.000Z","sourceNodeId":"g2:abc","sourceName":"Spencer's G2"},
          {"id":"m2","role":"assistant","text":"**Two** things.","at":"2026-09-28T15:40:05Z","sourceNodeId":null,"sourceName":null}
        ],"nextBefore":"m1"}
        """)
        XCTAssertEqual(page.thread, "agent")
        XCTAssertEqual(page.nextBefore, "m1")
        XCTAssertEqual(page.messages.map(\.id), ["m1", "m2"])
        XCTAssertEqual(page.messages[0].role, .user)
        XCTAssertEqual(page.messages[0].sourceName, "Spencer's G2")
        XCTAssertEqual(page.messages[0].sourceNodeId, "g2:abc")
        XCTAssertEqual(page.messages[1].role, .assistant)
        XCTAssertNil(page.messages[1].sourceNodeId)
        XCTAssertEqual(page.messages[0].at, ISO8601DateFormatter().date(from: "2026-09-28T15:40:00Z"))
    }

    func testConversationPageDropsAMalformedMessageAndKeepsTheRest() throws {
        let page = try decode(ConversationPage.self, """
        {"thread":"supervisor","messages":[
          {"id":"m1","role":"tool","text":"x","at":"2026-09-28T15:40:00Z"},
          {"role":"user","text":"no id","at":"2026-09-28T15:40:00Z"},
          {"id":"m3","role":"user","text":"ok","at":"2026-09-28T15:41:00Z"}
        ],"nextBefore":null}
        """)
        XCTAssertEqual(page.messages.map(\.id), ["m3"])
        XCTAssertNil(page.nextBefore)
    }

    func testConversationPageWithNoMessagesKeyIsEmpty() throws {
        let page = try decode(ConversationPage.self, #"{"thread":"agent"}"#)
        XCTAssertTrue(page.messages.isEmpty)
    }

    // MARK: - GET /lifelog/moments

    func testLifelogMomentsDecodeEveryField() throws {
        let response = try decode(LifelogMomentsResponse.self, """
        {"moments":[{"id":"life-1","nodeId":"g2:abc","deviceName":"Spencer's G2",
          "at":"2026-09-28T15:40:00.000Z","endAt":"2026-09-28T15:52:00.000Z",
          "title":"Standup with Ana","summary":"Agreed to ship Friday.","transcript":"Ana: ship Friday?"}]}
        """)
        let moment = try XCTUnwrap(response.moments.first)
        XCTAssertEqual(moment.id, "life-1")
        XCTAssertEqual(moment.deviceName, "Spencer's G2")
        XCTAssertEqual(moment.title, "Standup with Ana")
        XCTAssertEqual(moment.summary, "Agreed to ship Friday.")
        XCTAssertEqual(moment.transcript, "Ana: ship Friday?")
        XCTAssertEqual(moment.endAt?.timeIntervalSince(try XCTUnwrap(moment.at)), 12 * 60)
    }

    func testLifelogMomentStillBeingReviewedDecodesWithNulls() throws {
        let response = try decode(LifelogMomentsResponse.self, """
        {"moments":[{"id":"life-2","nodeId":null,"deviceName":null,"at":"","endAt":null,
          "title":null,"summary":null,"transcript":null},{"title":"no id"}]}
        """)
        XCTAssertEqual(response.moments.map(\.id), ["life-2"])
        XCTAssertNil(response.moments[0].at)
        XCTAssertEqual(LifelogFormat.title(response.moments[0]), "Conversation")
    }

    // MARK: - GET /fleet/api/state

    func testFleetStateDecodesTheFullShape() throws {
        let state = try decode(FleetState.self, """
        {"mode":"propose","enabled":true,"running":false,"lastTickAt":"2026-09-28T15:40:00.000Z","lastError":null,
         "snapshot":{"at":"2026-09-28T15:40:00.000Z","counts":{"threads":2},"threads":[
           {"key":"codex:1","kind":"codex","title":"Fix login","workspace":"amman","repo":"Spshulem/openAGI","branch":"spencer/x",
            "agentStatus":"idle","state":"needs-human","health":"red","reason":"Asked a question","blockers":["CI red"],
            "pr":{"ref":"Spshulem/openAGI#112","url":"https://github.com/Spshulem/openAGI/pull/112","state":"OPEN","title":"Fleet",
                  "ci":{"state":"FAILURE","failing":["test"],"pending":[]},"unresolvedThreads":2,"mergeState":"BLOCKED"},
            "lastActivityAt":"2026-09-28T15:30:00Z","lastAgentText":"Done?","error":{"kind":"usage-limit","resetAt":"2026-09-28T18:00:00Z"},
            "live":true,"route":"conductor","decision":{"action":"nudge","playbook":"ci-fix","reason":"CI failing","notBefore":null}},
           {"key":"claude:2","state":"running"}],
          "sourceErrors":{"conductor":"timeout","codex":""}},
         "questions":[{"id":"q1","title":"Merge?","body":"It is green.","options":["merge","wait","dismiss"],"kind":"agent-ask",
           "threadKey":"codex:1","threadKeys":null,"prRef":"Spshulem/openAGI#112","createdAt":"2026-09-28T15:35:00Z"}],
         "actions":[{"id":"a1","status":"proposed","playbook":"ci-fix","threadKey":"codex:1","message":"Please fix CI","at":"2026-09-28T15:36:00Z"}],
         "settings":{"maxAuto":3}}
        """)
        XCTAssertEqual(state.mode, "propose")
        XCTAssertTrue(state.enabled)
        XCTAssertNil(state.lastErrorText)
        let threads = try XCTUnwrap(state.snapshot?.threads)
        XCTAssertEqual(threads.count, 2)
        XCTAssertEqual(threads[0].pr?.ci?.failing, ["test"])
        XCTAssertEqual(threads[0].error?.kind, "usage-limit")
        XCTAssertEqual(threads[0].decision?.playbook, "ci-fix")
        XCTAssertEqual(FleetHealth.of(threads[0]), .red)
        XCTAssertEqual(FleetHealth.of(threads[1]), .green) // no health field: derived from state
        XCTAssertEqual(state.snapshot?.sourceErrorTexts, ["conductor": "timeout"])
        XCTAssertEqual(state.questions.first?.options, ["merge", "wait", "dismiss"])
        XCTAssertNil(state.questions.first?.threadKeys)
        XCTAssertEqual(state.actions.first?.status, "proposed")
    }

    func testFleetStateFromAFirstRunOrOlderDaemonDegradesInsteadOfThrowing() throws {
        let state = try decode(FleetState.self, """
        {"mode":null,"enabled":"yes","questions":null,"actions":[{"id":"a1"},42],
         "lastError":{"message":"scan crashed"},"snapshot":{"threads":[{"key":"x","blockers":null,"pr":"bad"}]}}
        """)
        XCTAssertNil(state.mode)
        XCTAssertFalse(state.enabled)
        XCTAssertTrue(state.questions.isEmpty)
        XCTAssertEqual(state.actions.map(\.id), ["a1"])
        XCTAssertEqual(state.lastErrorText, "scan crashed")
        XCTAssertEqual(state.snapshot?.threads.first?.blockers, [])
        XCTAssertNil(state.snapshot?.threads.first?.pr)
    }

    func testFleetMutationResultDecodesDeliveryAndState() throws {
        let result = try decode(FleetMutationResult.self, """
        {"question":{"id":"q1"},"delivery":{"status":"blocked","route":"conductor","detail":"agent offline"},"state":{"mode":"observe"}}
        """)
        XCTAssertEqual(result.delivery?.status, "blocked")
        XCTAssertEqual(result.state?.mode, "observe")
    }

    func testFleetHealthFallbackMatchesTheDaemonTable() {
        XCTAssertEqual(FleetHealth.fallback(state: "waiting-ci", hasError: false), .green)
        XCTAssertEqual(FleetHealth.fallback(state: "idle-no-pr", hasError: false), .yellow)
        XCTAssertEqual(FleetHealth.fallback(state: "infra-blocked", hasError: false), .red)
        XCTAssertEqual(FleetHealth.fallback(state: "idle-no-pr", hasError: true), .red)
        XCTAssertEqual(FleetHealth.fallback(state: "running", hasError: true), .green)
        XCTAssertEqual(FleetHealth.fallback(state: "excluded", hasError: true), .gray)
        XCTAssertEqual(FleetHealth.fallback(state: nil, hasError: false), .gray)
        XCTAssertEqual(FleetHealth.of(FleetThread(key: "k", state: "running", health: "purple")), .green)
    }

    // MARK: - /events

    func testConversationUpdatedEventCarriesItsThread() {
        XCTAssertEqual(DaemonEvent.from(name: "conversation.updated", data: #"{"thread":"supervisor","messageId":"m9"}"#),
                       .conversationUpdated(thread: "supervisor"))
        XCTAssertEqual(DaemonEvent.from(name: "conversation.updated", data: "not json"), .conversationUpdated(thread: nil))
        XCTAssertEqual(DaemonEvent.from(name: "fleet", data: "{}"), .fleet)
    }
}
