import XCTest
@testable import OpenAGI

// DESIGN.md's Chat section: "Consecutive messages from the same speaker
// tighten to 2pt apart; a change of speaker opens to 12. No timestamp
// unless more than 15 minutes passed, and then it is a centred `caption`
// in `muted` between the two groups." Pinned here independent of SwiftUI,
// the same way `RelativeTime`/`ConnectionDotState` are.
final class MessageGroupingTests: XCTestCase {
    func testTheFirstMessageInTheListHasNoSpacingRule() {
        XCTAssertEqual(MessageGrouping.spacing(previousRole: nil, currentRole: .user), 0)
        XCTAssertEqual(MessageGrouping.spacing(previousRole: nil, currentRole: .assistant), 0)
    }

    func testSameSpeakerTightensToTwoPoints() {
        XCTAssertEqual(MessageGrouping.spacing(previousRole: .user, currentRole: .user), 2)
        XCTAssertEqual(MessageGrouping.spacing(previousRole: .assistant, currentRole: .assistant), 2)
    }

    func testAChangeOfSpeakerOpensToTwelvePoints() {
        XCTAssertEqual(MessageGrouping.spacing(previousRole: .user, currentRole: .assistant), 12)
        XCTAssertEqual(MessageGrouping.spacing(previousRole: .assistant, currentRole: .user), 12)
    }

    func testNoTimestampDividerForTheFirstMessage() {
        XCTAssertFalse(MessageGrouping.needsTimestampDivider(previousTimestamp: nil, currentTimestamp: Date()))
    }

    func testNoDividerAtOrUnderFifteenMinutes() {
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertFalse(MessageGrouping.needsTimestampDivider(previousTimestamp: start, currentTimestamp: start.addingTimeInterval(15 * 60)))
        XCTAssertFalse(MessageGrouping.needsTimestampDivider(previousTimestamp: start, currentTimestamp: start.addingTimeInterval(60)))
    }

    func testADividerAppearsPastFifteenMinutes() {
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertTrue(MessageGrouping.needsTimestampDivider(previousTimestamp: start, currentTimestamp: start.addingTimeInterval(15 * 60 + 1)))
    }

    func testDisplayItemsComputesSpacingAndDividersInOnePass() {
        let base = Date(timeIntervalSince1970: 0)
        let messages = [
            ChatMessage(role: .user, text: "Hi", timestamp: base),
            ChatMessage(role: .assistant, text: "Hello", timestamp: base.addingTimeInterval(1)),
            ChatMessage(role: .assistant, text: "How can I help?", timestamp: base.addingTimeInterval(2)),
            ChatMessage(role: .user, text: "Later", timestamp: base.addingTimeInterval(20 * 60)),
        ]
        let items = MessageGrouping.displayItems(for: messages, timestampFormatter: { _ in "STAMP" })
        XCTAssertEqual(items.map(\.spacingBefore), [0, 12, 2, 12])
        XCTAssertEqual(items.map(\.timestampDividerText), [nil, nil, nil, "STAMP"])
    }

    func testDisplayItemsIsEmptyForAnEmptyMessageList() {
        XCTAssertTrue(MessageGrouping.displayItems(for: []).isEmpty)
    }
}
