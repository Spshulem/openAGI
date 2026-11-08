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
}
