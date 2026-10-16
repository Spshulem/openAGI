import UIKit
import UserNotifications
import XCTest
@testable import OpenAGI

// The HTTP side of push: what a button tap sends to the daemon, how its
// result is judged, and the two registration calls (relay, then daemon).
// Uses DaemonClientTests' StubProtocol, so nothing leaves the process.
final class SupervisorPushRequestTests: XCTestCase {
    override func tearDown() {
        StubProtocol.handler = nil
        StubProtocol.failure = nil
        StubProtocol.lastRequest = nil
        super.tearDown()
    }

    private var stubSession: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeClient() -> DaemonClient {
        DaemonClient(server: URL(string: "http://mac.tail1234.ts.net:43210")!, nodeID: "mobile:abc",
                     token: String(repeating: "a", count: 43), session: stubSession)
    }

    private func respond(_ status: Int, _ body: String) {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
    }

    private func body(of request: URLRequest) throws -> [String: Any] {
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Answer action → request

    private func send(_ action: SupervisorAnswerAction) async -> SupervisorAnswerOutcome {
        let client = makeClient()
        do {
            switch action {
            case let .answer(id, answer):
                return .of(error: nil, delivery: try await client.fleetAnswer(questionID: id, answer: answer).delivery)
            case let .dismiss(id):
                _ = try await client.fleetDismiss(questionID: id)
                return .done
            case .open:
                return .done
            }
        } catch {
            return .of(error: error, delivery: nil)
        }
    }

    func testAnswerButtonPostsTheExactOption() async throws {
        respond(200, #"{"delivery":{"status":"sent"}}"#)
        let action = try XCTUnwrap(SupervisorAnswerAction.from(
            actionIdentifier: "answer.1", defaultActionIdentifier: "default",
            userInfo: ["questionId": "fq123", "options": ["Approve", " Skip "]]))
        let outcome = await send(action)
        XCTAssertEqual(outcome, .done)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/fleet/api/questions/fq123")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:abc")
        XCTAssertEqual(try body(of: request) as? [String: String], ["answer": " Skip "])
    }

    func testDismissButtonPostsDismissTrue() async throws {
        respond(200, "{}")
        let outcome = await send(.dismiss(questionId: "fq123"))
        XCTAssertEqual(outcome, .done)
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/fleet/api/questions/fq123")
        XCTAssertEqual(try body(of: request) as? [String: Bool], ["dismiss": true])
    }

    func testAlreadyClosedQuestionCountsAsDone() async {
        respond(404, #"{"error":"not-found"}"#)
        let notFound = await send(.answer(questionId: "gone", answer: "Approve"))
        XCTAssertEqual(notFound, .done)
        respond(409, #"{"error":"closed"}"#)
        let conflict = await send(.dismiss(questionId: "gone"))
        XCTAssertEqual(conflict, .done)
    }

    func testFailuresAndUndeliveredAnswersAreNotSent() async {
        respond(500, "{}")
        let serverError = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(serverError, .failed)
        respond(401, "{}")
        let unauthorized = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(unauthorized, .failed)
        StubProtocol.failure = URLError(.notConnectedToInternet)
        let offline = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(offline, .failed)
        StubProtocol.failure = nil

        respond(200, #"{"delivery":{"status":"blocked","detail":"Agent is busy"}}"#)
        let blocked = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(blocked, .undelivered("Agent is busy"))
        respond(200, #"{"delivery":{"status":"failed"}}"#)
        let failed = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(failed, .undelivered("The agent could not be reached"))
        respond(200, #"{"delivery":{"status":"dry-run"}}"#)
        let dryRun = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(dryRun, .done)
    }

    func testStaleAlertsAreOnlyThoseForClosedQuestions() {
        let stale = SupervisorAnswerSender.staleNotificationIDs(
            delivered: [(id: "n1", questionID: "open"), (id: "n2", questionID: "closed"), (id: "n3", questionID: nil)],
            open: ["open"])
        XCTAssertEqual(stale, ["n2"])
    }

    // MARK: - Registration

    func testRelayRegisterSendsTokensAndReturnsPass() async throws {
        respond(200, #"{"pass":"p1.abc.def"}"#)
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        let pass = try await relay.register(deviceToken: "aa01", startToken: "bb02", env: "sandbox")
        XCTAssertEqual(pass, "p1.abc.def")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://push.example.com/v1/register")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "the relay never sees the node token")
        XCTAssertEqual(try body(of: request) as? [String: String],
                       ["deviceToken": "aa01", "startToken": "bb02", "env": "sandbox"])
    }

    func testRelayRegisterWithoutStartTokenOmitsIt() async throws {
        respond(200, #"{"pass":"p1.alerts.only"}"#)
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        let pass = try await relay.register(deviceToken: "aa01", startToken: nil, env: "production")
        XCTAssertEqual(pass, "p1.alerts.only")
        XCTAssertEqual(try body(of: XCTUnwrap(StubProtocol.lastRequest)) as? [String: String],
                       ["deviceToken": "aa01", "env": "production"])
    }

    func testRelayUnregisterSendsThePass() async throws {
        respond(200, #"{"ok":true}"#)
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        try await relay.unregister(pass: "p1.old.pass")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://push.example.com/v1/unregister")
        XCTAssertEqual(try body(of: request) as? [String: String], ["pass": "p1.old.pass"])
    }

    func testRelayErrorsAreTyped() async {
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        respond(429, #"{"error":"rate-limited"}"#)
        await assertRelayThrows(relay, .rejected("rate-limited"))
        respond(502, "oops")
        await assertRelayThrows(relay, .server(502))
        respond(200, #"{"pass":"not-a-pass"}"#)
        await assertRelayThrows(relay, .malformedResponse)
        StubProtocol.failure = URLError(.timedOut)
        await assertRelayThrows(relay, .transport)
    }

    private func assertRelayThrows(_ relay: PushRelayClient, _ expected: PushRelayError, line: UInt = #line) async {
        do {
            _ = try await relay.register(deviceToken: "a", startToken: "b", env: "sandbox")
            XCTFail("expected \(expected)", line: line)
        } catch {
            XCTAssertEqual(error as? PushRelayError, expected, line: line)
        }
    }

    func testDaemonRegisterAndUnregister() async throws {
        respond(200, #"{"ok":true}"#)
        let client = makeClient()
        let result = try await client.registerPush(pass: "p1.x.y", key: "SMOleUn2o5oqGjAszy9JO7-tK3avgOZmkjI34rcEBsM",
                                                   env: "production", activities: false, alerts: false)
        XCTAssertEqual(result, PushRegistrationResult(renew: false), "an older daemon sends no renew")
        var request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/mobile/push")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + String(repeating: "a", count: 43))
        let sent = try body(of: request)
        XCTAssertEqual(sent["pass"] as? String, "p1.x.y")
        XCTAssertEqual(sent["key"] as? String, "SMOleUn2o5oqGjAszy9JO7-tK3avgOZmkjI34rcEBsM")
        XCTAssertEqual(sent["env"] as? String, "production")
        XCTAssertEqual(sent["activities"] as? Bool, false)
        XCTAssertEqual(sent["alerts"] as? Bool, false)
        XCTAssertEqual(sent.count, 5)

        respond(200, #"{"ok":true,"renew":true}"#)
        let renew = try await client.registerPush(pass: "p1.x.y", key: "k", env: "sandbox", activities: true, alerts: true)
        XCTAssertEqual(renew, PushRegistrationResult(renew: true))
        let second = try body(of: XCTUnwrap(StubProtocol.lastRequest))
        XCTAssertEqual(second["activities"] as? Bool, true)
        XCTAssertEqual(second["alerts"] as? Bool, true)

        respond(200, #"{"ok":true,"renew":false}"#)

        try await client.unregisterPush()
        request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/mobile/push")
    }

    func testRelayURLOverride() {
        XCTAssertEqual(PushRelayClient.configuredURL(info: nil), PushRelayClient.defaultURL)
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": ""]), PushRelayClient.defaultURL)
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": "https://relay.example.com"]),
                       URL(string: "https://relay.example.com"))
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": "http://relay.example.com"]),
                       PushRelayClient.defaultURL, "plain http only for loopback")
        XCTAssertEqual(PushRelayClient.configuredURL(info: ["OpenAGIPushRelay": "http://localhost:8787"]),
                       URL(string: "http://localhost:8787"))
        XCTAssertEqual(PushRelayClient.defaultURL.absoluteString, "https://push.openagi.sh")
    }

    func testRegistrationSignatureChangesWithEveryInput() {
        let relay = PushRelayClient.defaultURL
        let base = PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", relay: relay)
        XCTAssertEqual(base, PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", relay: relay))
        XCTAssertFalse(base.contains("d\n"), "hashed, not the raw tokens")
        let variants = [
            PushRegistrar.signature(deviceToken: "d2", startToken: "s", env: "sandbox", relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s2", env: "sandbox", relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: nil, env: "sandbox", relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "production", relay: relay),
            PushRegistrar.signature(deviceToken: "d", startToken: "s", env: "sandbox", relay: URL(string: "https://relay.example.com")!)
        ]
        XCTAssertEqual(Set(variants + [base]).count, 6)
    }

    // MARK: - Registration steps

    private let now = Date(timeIntervalSince1970: 1_792_065_600)

    func testNothingHappensUnpairedOrWithoutADeviceToken() {
        let stored = PushPassStore.Stored(pass: "p1.a", signature: "sig", mintedAt: now)
        XCTAssertEqual(PushRegistrar.step(paired: false, signature: "sig", stored: stored, now: now), .idle)
        XCTAssertEqual(PushRegistrar.step(paired: true, signature: nil, stored: stored, now: now), .idle)
    }

    func testFirstRegistrationAsksTheRelay() {
        XCTAssertEqual(PushRegistrar.step(paired: true, signature: "sig", stored: nil, now: now), .register(replacing: nil))
    }

    // Same tokens: every sync re-posts the stored pass to the daemon (it may
    // have lost the record), and never mints a second relay channel.
    func testUnchangedRegistrationRepostsTheStoredPass() {
        let stored = PushPassStore.Stored(pass: "p1.a", signature: "sig", mintedAt: now.addingTimeInterval(-6 * 86_400))
        XCTAssertEqual(PushRegistrar.step(paired: true, signature: "sig", stored: stored, now: now), .post(pass: "p1.a"))
    }

    // A token changed (rotation, Live Activities turned on or off):
    // re-register and retire the old pass.
    func testChangedTokensReRegisterAndRetireTheOldPass() {
        let stored = PushPassStore.Stored(pass: "p1.old", signature: "old-sig", mintedAt: now)
        XCTAssertEqual(PushRegistrar.step(paired: true, signature: "new-sig", stored: stored, now: now), .register(replacing: "p1.old"))
    }

    // Re-minted every 7 days (the relay expires passes at 30), and whenever
    // the stored pass has no mint date: saved by an older build, or marked
    // after the daemon answered renew.
    func testOldOrUndatedPassIsReminted() {
        let weekOld = PushPassStore.Stored(pass: "p1.old", signature: "sig", mintedAt: now.addingTimeInterval(-7 * 86_400))
        XCTAssertEqual(PushRegistrar.step(paired: true, signature: "sig", stored: weekOld, now: now), .register(replacing: "p1.old"))
        let undated = PushPassStore.Stored(pass: "p1.old", signature: "sig")
        XCTAssertEqual(PushRegistrar.step(paired: true, signature: "sig", stored: undated, now: now), .register(replacing: "p1.old"))
    }

    func testDaemonRenewMintsOnlyForAPassNotJustMinted() {
        XCTAssertTrue(PushRegistrar.shouldRenew(daemonSaysRenew: true, justMinted: false))
        XCTAssertFalse(PushRegistrar.shouldRenew(daemonSaysRenew: true, justMinted: true))
        XCTAssertFalse(PushRegistrar.shouldRenew(daemonSaysRenew: false, justMinted: false))
    }

    func testAlertsFollowNotificationPermission() {
        XCTAssertTrue(PushRegistrar.alertsAllowed(.authorized))
        XCTAssertTrue(PushRegistrar.alertsAllowed(.provisional))
        XCTAssertTrue(PushRegistrar.alertsAllowed(.ephemeral))
        XCTAssertFalse(PushRegistrar.alertsAllowed(.denied))
        XCTAssertFalse(PushRegistrar.alertsAllowed(.notDetermined))
    }

    func testPassStoreRoundTripsThroughTheKeychain() {
        PushPassStore.clear()
        defer { PushPassStore.clear() }
        XCTAssertNil(PushPassStore.load())
        PushPassStore.save(.init(pass: "p1.x", signature: "s1"))
        XCTAssertEqual(PushPassStore.load(), .init(pass: "p1.x", signature: "s1"))
        PushPassStore.save(.init(pass: "p1.y", signature: "s2", mintedAt: now, retire: "p1.x"))
        XCTAssertEqual(PushPassStore.load(), .init(pass: "p1.y", signature: "s2", mintedAt: now, retire: "p1.x"))
    }

    // forget() bumps the generation and marks the node forgotten; an
    // in-flight sync must stop at its next step.
    func testSyncStopsOnceForgottenOrRepaired() {
        XCTAssertTrue(PushRegistrar.isCurrent(started: 3, now: 3, startedNodeID: "n", currentNodeID: "n", forgotten: []))
        XCTAssertFalse(PushRegistrar.isCurrent(started: 3, now: 4, startedNodeID: "n", currentNodeID: "n", forgotten: []),
                       "forget ran since the sync started")
        XCTAssertFalse(PushRegistrar.isCurrent(started: 3, now: 3, startedNodeID: "n", currentNodeID: "n", forgotten: ["n"]),
                       "node already forgotten, credentials not cleared yet")
        XCTAssertFalse(PushRegistrar.isCurrent(started: 3, now: 3, startedNodeID: "n", currentNodeID: nil, forgotten: []),
                       "credentials gone")
        XCTAssertFalse(PushRegistrar.isCurrent(started: 3, now: 3, startedNodeID: "n", currentNodeID: "m", forgotten: []),
                       "re-paired to another node")
    }

    // MARK: - Background assertion

    @MainActor
    func testBackgroundTaskEndsOnceWhenItExpires() {
        var expiration: (@MainActor () -> Void)?
        var ended: [UIBackgroundTaskIdentifier] = []
        var expired = 0
        let guardTask = BackgroundTaskGuard(beginTask: { handler in expiration = handler; return UIBackgroundTaskIdentifier(rawValue: 7) },
                                            endTask: { ended.append($0) })
        guardTask.begin { expired += 1 }
        expiration?()
        guardTask.end()
        XCTAssertEqual(expired, 1)
        XCTAssertEqual(ended, [UIBackgroundTaskIdentifier(rawValue: 7)])
    }

    @MainActor
    func testBackgroundTaskEndsOnceOnTheNormalPath() {
        var ended = 0
        let guardTask = BackgroundTaskGuard(beginTask: { _ in UIBackgroundTaskIdentifier(rawValue: 9) },
                                            endTask: { _ in ended += 1 })
        guardTask.begin {}
        guardTask.end()
        guardTask.end()
        XCTAssertEqual(ended, 1)
    }

    // MARK: - Duplicate Live Activities

    func testOnlyTheNewestActivitySurvives() {
        XCTAssertEqual(PushRegistrar.activityIDsToEnd(current: [], firstSeen: [:]), [])
        XCTAssertEqual(PushRegistrar.activityIDsToEnd(current: ["a"], firstSeen: [:]), [])
        // Never seen start in this process: the system's last one wins.
        XCTAssertEqual(PushRegistrar.activityIDsToEnd(current: ["a", "b", "c"], firstSeen: [:]), ["a", "b"])
        // Seen start here: the latest seen wins over system order.
        XCTAssertEqual(PushRegistrar.activityIDsToEnd(current: ["b", "a", "c"], firstSeen: ["c": 0, "b": 1]), ["a", "c"])
        XCTAssertEqual(PushRegistrar.activityIDsToEnd(current: ["x", "y"], firstSeen: ["x": 3]), ["y"])
    }

    func testHexToken() {
        XCTAssertEqual(Data([0x00, 0xAB, 0x0F]).hexString, "00ab0f")
    }
}

// The push key runs through the real keychain in the xctest host, same as
// CredentialsTests, so this proves the ungrouped pattern works for it too.
final class PushKeyStoreTests: XCTestCase {
    override func tearDown() {
        PushKeyStore.clear()
        super.tearDown()
    }

    func testCreateIsStableUntilCleared() throws {
        PushKeyStore.clear()
        XCTAssertNil(PushKeyStore.load())
        let key = try PushKeyStore.loadOrCreate()
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(PushKeyStore.load(), key)
        XCTAssertEqual(try PushKeyStore.loadOrCreate(), key)
        XCTAssertEqual(key.base64URLEncodedString().count, 43)
        PushKeyStore.clear()
        XCTAssertNil(PushKeyStore.load())
        XCTAssertNotEqual(try PushKeyStore.loadOrCreate(), key)
    }
}
