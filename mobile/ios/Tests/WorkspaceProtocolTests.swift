import XCTest
@testable import OpenAGI

final class WorkspaceProtocolTests: XCTestCase {
    func testModelSettingsDecodesWhatTheDaemonSends() throws {
        let json = """
        {"preference":"auto","active":{"provider":"anthropic","model":"claude-sonnet-4-6","offlineFallback":true},
         "providers":{"anthropic":{"configured":true,"model":null},"openai":{"configured":false,"model":"gpt-5"},
                      "onDevice":{"available":true,"connected":false}}}
        """
        let settings = try ProtocolDecoder.json.decode(ModelSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.active.provider, "anthropic")
        XCTAssertEqual(settings.active.offlineFallback, true)
        XCTAssertTrue(settings.providers.anthropic.configured)
        XCTAssertNil(settings.providers.chatgpt)
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
}
