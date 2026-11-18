import XCTest
import SupervisorChannelsKit

final class FleetChannelGroupingTests: XCTestCase {
  func testNormalizeProjectPrefersExplicitThenRepoThenFolder() {
    XCTAssertEqual(SupervisorChannelGrouping.normalizeProject(explicit: "buildbetter", repo: "acme/other"), "buildbetter")
    XCTAssertEqual(SupervisorChannelGrouping.normalizeProject(explicit: "General", repo: "buildbetter-app/bb-recorder"), "bb-recorder")
    XCTAssertEqual(SupervisorChannelGrouping.normalizeProject(cwd: "/Users/dev/openAGI/"), "openAGI")
    XCTAssertEqual(SupervisorChannelGrouping.normalizeProject(), "general")
  }

  func testGroupByProjectOrdersWaitingHighestFirstWithGeneralLast() {
    let items = [
      SupervisorDecisionItem(id: "1", project: "general", headline: "Cleanup"),
      SupervisorDecisionItem(id: "2", project: "bb-recorder", headline: "Notarize DMG"),
      SupervisorDecisionItem(id: "3", project: "buildbetter", headline: "Merge #9958"),
      SupervisorDecisionItem(id: "4", project: "buildbetter", headline: "Strict citations"),
    ]
    let groups = SupervisorChannelGrouping.groupByProject(items)
    XCTAssertEqual(groups.map(\.project), ["buildbetter", "bb-recorder", "general"])
    XCTAssertEqual(groups[0].items.map(\.id), ["3", "4"])
  }

  func testCalmOverlapsIgnoresIdleAndMultiHostAndOnlyWarnsWhenTwoRunningShareCwdOnOneHost() {
    let sessions = [
      SupervisorSessionBrief(id: "idle1", project: "buildbetter", title: "Idle 1", host: "MacBook", cwd: "/Users/dev/bb", state: "idle"),
      SupervisorSessionBrief(id: "idle2", project: "buildbetter", title: "Idle 2", host: "MacBook", cwd: "/Users/dev/bb", state: "idle"),
      SupervisorSessionBrief(id: "remote1", project: "buildbetter", title: "Remote", host: "BuildBot3", cwd: "/home/dev/bb", state: "running"),
      SupervisorSessionBrief(id: "run1", project: "buildbetter", title: "Run 1", host: "MacBook", cwd: "/Users/dev/bb", state: "running"),
      SupervisorSessionBrief(id: "run2", project: "buildbetter", title: "Run 2", host: "MacBook", cwd: "/Users/dev/bb/", state: "running"),
    ]
    let overlaps = SupervisorChannelGrouping.calmOverlaps(for: sessions)
    XCTAssertEqual(overlaps.count, 1)
    XCTAssertEqual(overlaps[0].detail, "2 running chats are editing bb simultaneously")
  }

  func testOverlayPendingActionFilterDropsStaleChatAndKeepsQueue() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let iso = ISO8601DateFormatter()
    let freshChat = iso.string(from: now.addingTimeInterval(-1800))
    let staleChat = iso.string(from: now.addingTimeInterval(-9000))

    XCTAssertTrue(SupervisorChannelGrouping.shouldShowInOverlay(mode: "chat", raisedAtISO: freshChat, createdAtISO: nil, now: now))
    XCTAssertFalse(SupervisorChannelGrouping.shouldShowInOverlay(mode: "chat", raisedAtISO: staleChat, createdAtISO: nil, now: now))
    XCTAssertFalse(SupervisorChannelGrouping.shouldShowInOverlay(mode: "chat", raisedAtISO: nil, createdAtISO: nil, now: now))
    XCTAssertTrue(SupervisorChannelGrouping.shouldShowInOverlay(mode: "queue", raisedAtISO: staleChat, createdAtISO: nil, now: now))
  }
}
