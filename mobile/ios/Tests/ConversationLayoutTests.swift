import XCTest
@testable import OpenAGI

final class ConversationLayoutTests: XCTestCase {
    func testBookKeepsMessagesAndComposerOnTheirOwnPages() {
        let fold = CGRect(x: 480, y: 0, width: 40, height: 800)
        let regions = ConversationRegions(size: .init(width: 1000, height: 800), division: fold)
        XCTAssertEqual(regions.input.minX, fold.maxX)
        XCTAssertEqual(regions.input.maxX, 1000)
        XCTAssertEqual(regions.history.maxX, fold.minX)
        XCTAssertEqual(regions.historyHeight, 800)
        XCTAssertFalse(regions.history.intersects(regions.input))
        let rtl = ConversationRegions(size: .init(width: 1000, height: 800), division: fold, rightToLeft: true)
        XCTAssertEqual(rtl.input.maxX, fold.minX)
        XCTAssertEqual(rtl.history.minX, fold.maxX)
    }

    func testTabletopKeepsHistoryAboveFoldAndComposerBelow() {
        let regions = ConversationRegions(size: .init(width: 700, height: 1000),
                                          division: .init(x: 0, y: 480, width: 700, height: 40))
        XCTAssertEqual(regions.historyHeight, 480)
        XCTAssertEqual(regions.input.minY, 520)
        XCTAssertEqual(regions.input.maxY, 1000)
    }

    func testSplitWindowIgnoresFoldOutsideItsBounds() {
        let regions = ConversationRegions(size: .init(width: 350, height: 700),
                                          division: .init(x: 480, y: 0, width: 40, height: 800))
        XCTAssertEqual(regions.input, CGRect(x: 0, y: 0, width: 350, height: 700))
        XCTAssertNil(regions.historyHeight)
    }

    // The largest accessibility text on a 6.9" iPhone: the expanded decision
    // deck and composer wanted ~754 pt of a 757 pt chat, and drew over the
    // 73 pt Supervisor channel bar, so #needs-you could not be tapped.
    func testSharedRegionInputStopsBelowTheHistoryHeader() {
        let regions = ConversationRegions(size: .init(width: 440, height: 757), division: nil)
        var offered: CGFloat?
        let height = regions.inputHeight(ideal: 754, reservedHistory: 73) { room in
            offered = room
            return room
        }
        XCTAssertEqual(offered, 684)
        XCTAssertEqual(height, 684, "The deck gives way; the channel bar stays clear")
    }

    func testInputThatCannotShrinkKeepsItsHeightSoTheComposerStaysOnScreen() {
        let regions = ConversationRegions(size: .init(width: 440, height: 757), division: nil)
        XCTAssertEqual(regions.inputHeight(ideal: 754, reservedHistory: 73) { _ in 700 }, 700)
        XCTAssertEqual(regions.inputHeight(ideal: 900, reservedHistory: 73) { _ in 900 }, 757,
                       "Never taller than the region")
    }

    func testInputThatFitsIsNotAskedToShrink() {
        let regions = ConversationRegions(size: .init(width: 440, height: 757), division: nil)
        XCTAssertEqual(regions.inputHeight(ideal: 300, reservedHistory: 73) { _ in
            XCTFail("An input that fits is not measured again")
            return 0
        }, 300)
    }

    func testFoldRegionsIgnoreTheHistoryHeader() {
        let regions = ConversationRegions(size: .init(width: 700, height: 1000),
                                          division: .init(x: 0, y: 480, width: 700, height: 40))
        XCTAssertEqual(regions.inputHeight(ideal: 600, reservedHistory: 300) { _ in 0 }, 480)
    }

    func testBookSizesTheConversationListToTheLeadingPage() {
        let fold = CGRect(x: 470, y: 0, width: 12, height: 660)
        XCTAssertEqual(ChatBookPages.sidebarWidth(division: fold, size: .init(width: 950, height: 660), rightToLeft: false), 470)
        XCTAssertEqual(ChatBookPages.sidebarWidth(division: fold, size: .init(width: 950, height: 660), rightToLeft: true), 468)
        XCTAssertNil(ChatBookPages.sidebarWidth(division: .init(x: 0, y: 320, width: 950, height: 12),
                                                size: .init(width: 950, height: 660), rightToLeft: false))
        XCTAssertNil(ChatBookPages.sidebarWidth(division: nil, size: .init(width: 950, height: 660), rightToLeft: false))
    }
}
