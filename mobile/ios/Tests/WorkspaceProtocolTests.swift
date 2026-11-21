import XCTest
@testable import OpenAGI

final class WorkspaceProtocolTests: XCTestCase {
    func testModelSettingsDecodesWhatTheDaemonSends() throws {
        let json = """
        {"preference":"auto","active":{"provider":"anthropic","model":"claude-sonnet-4-6","offlineFallback":true},
         "providers":{"anthropic":{"configured":true,"model":null},"openai":{"configured":false,"model":"gpt-5"},
                      "onDevice":{"available":true,"connected":false},
                      "claudeCli":{"available":true,"model":"claude-sonnet-4-6"},
                      "codexCli":{"available":true,"model":"gpt-5.4"}}}
        """
        let settings = try ProtocolDecoder.json.decode(ModelSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.active.provider, "anthropic")
        XCTAssertEqual(settings.active.offlineFallback, true)
        XCTAssertTrue(settings.providers.anthropic.configured)
        XCTAssertEqual(settings.providers.claudeCli?.available, true)
        XCTAssertEqual(settings.providers.codexCli?.model, "gpt-5.4")
        XCTAssertNil(settings.providers.chatgpt)
        XCTAssertTrue(settings.hasUsableCloudModel)
    }

    func testOnboardingRequiresTheActiveCloudProviderToBeConfigured() {
        let configured = ModelSettings.KeyProvider(configured: true, model: nil)
        let missing = ModelSettings.KeyProvider(configured: false, model: nil)
        func settings(_ provider: String?, anthropic: ModelSettings.KeyProvider = .init(configured: false, model: nil),
                      openai: ModelSettings.KeyProvider = .init(configured: false, model: nil),
                      signedIn: Bool? = nil,
                      claudeCli: ModelSettings.CliProvider? = nil,
                      codexCli: ModelSettings.CliProvider? = nil) -> ModelSettings {
            ModelSettings(preference: "auto", active: .init(provider: provider, model: nil, offlineFallback: false),
                          providers: .init(anthropic: anthropic, openai: openai, onDevice: nil,
                                           chatgpt: signedIn.map { .init(signedIn: $0, email: nil) },
                                           claudeCli: claudeCli, codexCli: codexCli))
        }
        XCTAssertTrue(settings("openai", openai: configured).hasUsableCloudModel)
        XCTAssertTrue(settings("chatgpt", signedIn: true).hasUsableCloudModel)
        XCTAssertTrue(settings("claude-cli", claudeCli: .init(available: true)).hasUsableCloudModel)
        XCTAssertTrue(settings("codex-cli", codexCli: .init(available: true)).hasUsableCloudModel)
        XCTAssertFalse(settings("claude-cli", claudeCli: .init(available: false)).hasUsableCloudModel)
        XCTAssertFalse(settings("anthropic", anthropic: missing, openai: configured).hasUsableCloudModel)
        XCTAssertFalse(settings("openai", anthropic: configured).hasUsableCloudModel)
        XCTAssertFalse(settings("chatgpt", signedIn: false).hasUsableCloudModel)
        XCTAssertFalse(settings("chatgpt").hasUsableCloudModel)
        XCTAssertFalse(settings("on-device", openai: configured).hasUsableCloudModel)
        XCTAssertFalse(settings("none").hasUsableCloudModel)
        XCTAssertFalse(settings(nil).hasUsableCloudModel)
    }

    func testUpdateOmitsUnsetFields() throws {
        let data = try ProtocolDecoder.jsonEncoder.encode(ModelSettingsUpdate(preference: "openai", openaiKey: "sk-1"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["preference", "openaiKey"])
    }

    func testScheduleLabels() throws {
        func job(_ extra: String) throws -> ScheduledJob {
            try ProtocolDecoder.json.decode(ScheduledJob.self, from: Data(#"{"id":"j","name":"J","enabled":true\#(extra)}"#.utf8))
        }
        XCTAssertEqual(try job(#","dailyAt":"08:00""#).scheduleLabel, "Daily at 08:00")
        XCTAssertEqual(try job(#","intervalMs":900000"#).scheduleLabel, "Every 15 min")
        XCTAssertEqual(try job(#","intervalMs":3600000"#).scheduleLabel, "Every hour")
        XCTAssertEqual(try job(#","intervalMs":21600000"#).scheduleLabel, "Every 6 hours")
        XCTAssertEqual(try job("").scheduleLabel, "On demand")
    }

    func testSkillNameSlug() {
        XCTAssertEqual(SkillName.slug("Plan My Week!"), "plan-my-week")
        XCTAssertEqual(SkillName.slug("  --grocery__list-- "), "grocery-list")
        XCTAssertEqual(SkillName.slug("!!!"), "")
    }

    func testSupervisorCardDecodesSuggestionPlan() throws {
        let json = """
        {
          "id": "card:fq_1",
          "questionId": "fq_1",
          "kind": "suggestion",
          "headline": "Needs owner answer before acting",
          "options": ["Answer question", "Review plan", "Not now", "Never"],
          "plan": {
            "remedy": "clarification",
            "label": "Clarify retry backoff",
            "nextAction": "Should automated retries cap backoff at 60s?",
            "acceptance": "Cap retry delay at 60s."
          }
        }
        """
        let card = try ProtocolDecoder.json.decode(SupervisorCard.self, from: Data(json.utf8))
        XCTAssertEqual(card.plan?.remedy, "clarification")
        XCTAssertEqual(card.plan?.label, "Clarify retry backoff")
        XCTAssertEqual(card.plan?.nextAction, "Should automated retries cap backoff at 60s?")
        XCTAssertEqual(card.plan?.acceptance, "Cap retry delay at 60s.")
    }

    func testBudgetProtocolAndExceededDetection() throws {
        let json = """
        {"today":"2026-11-21","dailyUsdLimit":10,"bonusUsdToday":10,"effectiveLimitUsd":20,
         "spentUsd":10.42,"remainingUsd":9.58,"exceeded":false,"calls":38}
        """
        let status = try ProtocolDecoder.json.decode(BudgetStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.effectiveLimit, 20)
        XCTAssertFalse(status.isExceeded)

        let encoded = try ProtocolDecoder.jsonEncoder.encode(BudgetUpdate(addUsdToday: 10))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["addUsdToday"])
        XCTAssertEqual(body["addUsdToday"] as? Double, 10)

        let hit = ChatMessage(role: .assistant, text: "I couldn't complete that request: Daily budget exceeded")
        let normal = ChatMessage(role: .assistant, text: "All tests passed.")
        let userLine = ChatMessage(role: .user, text: "Daily budget exceeded?")
        XCTAssertTrue(BudgetLimitPrompt.isBudgetExceeded(hit))
        XCTAssertFalse(BudgetLimitPrompt.isBudgetExceeded(normal))
        XCTAssertFalse(BudgetLimitPrompt.isBudgetExceeded(userLine))
    }

    func testFleetWatchdogDecodingAndBadges() throws {
        let json = """
        {
          "key": "paseo:srv_1.504212e5",
          "title": "Staging QA Report Analysis",
          "agentStatus": "stalled",
          "state": "stopped",
          "watchdog": {
            "phase": "stalled",
            "expectedMinutes": 15,
            "silentMinutes": 930,
            "checkInDueAt": "2026-11-20T17:15:00.000Z",
            "overdue": true,
            "overdueMinutes": 915,
            "severelyStuck": true,
            "status": "stuck",
            "diagnosis": {
              "kind": "silent-turn",
              "label": "silent 15h with no progress",
              "resolution": "auto-nudge"
            }
          }
        }
        """
        let thread = try ProtocolDecoder.json.decode(FleetThread.self, from: Data(json.utf8))
        XCTAssertEqual(thread.watchdog?.severelyStuck, true)
        XCTAssertEqual(thread.watchdog?.isAlert, true)
        XCTAssertEqual(thread.watchdog?.badgeText, "Stuck 15h · silent 15h with no progress")

        let overdue = FleetWatchdog(expectedMinutes: 25, silentMinutes: 35, overdue: true, overdueMinutes: 10, severelyStuck: false, status: "overdue")
        XCTAssertEqual(overdue.badgeText, "Check-in overdue +10m")
        XCTAssertTrue(overdue.isAlert)
    }
}
