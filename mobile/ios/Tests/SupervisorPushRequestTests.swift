import UIKit
import UserNotifications
import XCTest
import os
@testable import OpenAGI

// The HTTP side of push: what a button tap sends to the daemon, how its
// result is judged, and the two registration calls (relay, then daemon).
// Uses DaemonClientTests' StubProtocol, so nothing leaves the process.
final class SupervisorPushRequestTests: XCTestCase {
    func testPushEnvironmentComesFromTheSigningProfile() {
        func profile(_ aps: String?) -> Data {
            let entitlements = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
            let plist = #"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>"#
                + "<key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>"
            // Wrapped like the CMS signature around a real profile.
            return Data([0x30, 0x82, 0x00, 0xff]) + Data(plist.utf8) + Data([0xa0, 0x00, 0x31])
        }
        XCTAssertEqual(PushRegistrar.environment(profile: profile("development")), "sandbox")
        XCTAssertEqual(PushRegistrar.environment(profile: profile("production")), "production")
        XCTAssertEqual(PushRegistrar.environment(profile: profile(nil)), "sandbox")
        XCTAssertEqual(PushRegistrar.environment(profile: Data("garbage".utf8)), "sandbox")
        // No profile: an App Store build (the simulator has no real tokens).
        XCTAssertEqual(PushRegistrar.environment(profile: nil), "sandbox", "tests run on the simulator")
    }

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
        StubProtocol.failure = URLError(.timedOut)
        let timedOut = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(timedOut, .unknown)
        StubProtocol.failure = URLError(.cancelled)
        let cancelled = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(cancelled, .unknown)
        StubProtocol.failure = nil

        respond(200, #"{"delivery":{"status":"blocked","detail":"Agent is busy"}}"#)
        let blocked = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(blocked, .undelivered("Agent is busy"))
        respond(200, #"{"delivery":{"status":"queued","detail":"Saved."}}"#)
        let queued = await send(.answer(questionId: "q", answer: "Approve"))
        XCTAssertEqual(queued, .done, "queued answers are durably accepted")
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

    func testRelayUnregisterAcceptsRetiredPassesAndRetriesTemporaryErrors() async throws {
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: stubSession)
        for code in ["pass_expired", "pass_revoked"] {
            respond(400, "{\"error\":\"\(code)\"}")
            try await relay.unregister(pass: "p1.old.pass")
        }
        for (status, expected) in [(429, PushRelayError.server(429)), (503, .server(503))] {
            respond(status, "temporary failure")
            do {
                try await relay.unregister(pass: "p1.old.pass")
                XCTFail("Temporary unregister failures must remain retryable")
            } catch {
                XCTAssertEqual(error as? PushRelayError, expected)
            }
        }
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
        let retiring = PushPassStore.Stored(pass: "p1.y", signature: "s2", mintedAt: now,
                                           retire: "p1.x", retiringActivityIDs: ["old-activity"])
        XCTAssertTrue(PushPassStore.save(retiring))
        XCTAssertEqual(PushPassStore.load()?.retiringActivityIDs, ["old-activity"],
                       "relaunch must retain the old IDs rather than capture a new activity")
        let legacy = Data(#"{"pass":"p1.old","signature":"s1"}"#.utf8)
        XCTAssertNil(try? JSONDecoder().decode(PushPassStore.Stored.self, from: legacy).retiringActivityIDs)
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

    @MainActor
    func testFailedRenewalSaveDoesNotStartAnotherDaemonRequest() async throws {
        let suite = "push-renew-test-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("device", forKey: "push.deviceToken")
        defer {
            defaults.removePersistentDomain(forName: suite)
            Credentials.clear(); PushPassStore.clear(); PushKeyStore.clear()
        }
        try Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:renew", token: "token").save()
        let signature = PushRegistrar.signature(deviceToken: "device", startToken: nil, env: PushRegistrar.env,
                                                 relay: PushRelayClient.configuredURL())
        XCTAssertTrue(PushPassStore.save(.init(pass: "p1.fresh.pass", signature: signature, mintedAt: Date())))
        let requests = OSAllocatedUnfairLock(initialState: 0)
        StubProtocol.handler = { request in
            requests.withLock { $0 += 1 }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                    Data(#"{"ok":true,"renew":true}"#.utf8))
        }
        var writes = 0
        let session = stubSession
        defer { session.invalidateAndCancel() }
        let registrar = PushRegistrar(defaults: defaults, session: session, savePass: { _ in writes += 1; return false })
        let finished = expectation(description: "failed persistence stops immediate renewal")
        let syncing = Task { await registrar.sync(); finished.fulfill() }
        let result = await XCTWaiter.fulfillment(of: [finished], timeout: 2)
        syncing.cancel()
        XCTAssertEqual(result, .completed)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(requests.withLock { $0 }, 1)
        XCTAssertNotNil(PushPassStore.load()?.mintedAt, "the durable previous record remains intact")
    }

    @MainActor
    func testBackgroundCancellationStopsAnAwaitedPushRegistration() async throws {
        let suite = "push-cancel-test-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("device", forKey: "push.deviceToken")
        let started = expectation(description: "relay registration started")
        let stopped = expectation(description: "relay registration cancelled")
        let finished = expectation(description: "background synchronization returned")
        SuspendedPushSyncProtocol.started = started
        SuspendedPushSyncProtocol.stopped = stopped
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SuspendedPushSyncProtocol.self]
        let session = URLSession(configuration: config)
        defer {
            session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
            Credentials.clear(); PushPassStore.clear(); PushKeyStore.clear()
            SuspendedPushSyncProtocol.started = nil; SuspendedPushSyncProtocol.stopped = nil
        }
        PushPassStore.clear()
        try Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:cancel", token: "token").save()
        let registrar = PushRegistrar(defaults: defaults, session: session)
        let refreshing = Task { await registrar.sync(); finished.fulfill() }
        let entered = await XCTWaiter.fulfillment(of: [started], timeout: 2)
        refreshing.cancel()
        XCTAssertEqual(entered, .completed)
        let cancelled = await XCTWaiter.fulfillment(of: [stopped, finished], timeout: 2)
        XCTAssertEqual(cancelled, .completed)
        XCTAssertNil(PushPassStore.load(), "cancelled registration cannot persist or post a pass")
    }

    func testBackgroundRefreshExpirationCompletesOnlyOnce() {
        let outcomes = OSAllocatedUnfairLock(initialState: [Bool]())
        let completion = BackgroundRefreshCompletion { success in outcomes.withLock { $0.append(success) } }
        completion.finish(success: false)
        completion.finish(success: true)
        completion.finish(success: false)
        XCTAssertEqual(outcomes.withLock { $0 }, [false])
    }

    @MainActor
    func testForgettingDoesNotWaitForUnresponsivePushCleanup() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [UnresponsivePushCleanupProtocol.self]
        let session = URLSession(configuration: config)
        defer {
            session.invalidateAndCancel()
            PushPassStore.clear()
            PushKeyStore.clear()
        }
        _ = try PushKeyStore.loadOrCreate()
        XCTAssertTrue(PushPassStore.save(.init(pass: "p1.current.pass", signature: "s",
                                               retire: "p1.old.pass")))
        let client = DaemonClient(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:old",
                                  token: "old-token", session: session)
        let relay = PushRelayClient(base: URL(string: "https://push.example.com")!, session: session)
        let registrar = PushRegistrar()
        let finished = expectation(description: "local cleanup lets credential revocation continue")
        let forgetting = Task {
            await registrar.forget(client: client, relay: relay)
            XCTAssertNil(PushPassStore.load())
            XCTAssertNil(PushKeyStore.load())
            finished.fulfill()
        }
        let result = await XCTWaiter.fulfillment(of: [finished], timeout: 1)
        XCTAssertEqual(result, .completed)
        forgetting.cancel()
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

// The daemon answers, but relay cleanup stays pending until cancellation.
private final class UnresponsivePushCleanupProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.host == "daemon.example.com" else { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class SuspendedPushSyncProtocol: URLProtocol {
    nonisolated(unsafe) static var started: XCTestExpectation?
    nonisolated(unsafe) static var stopped: XCTestExpectation?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.started?.fulfill() }
    override func stopLoading() { Self.stopped?.fulfill() }
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
