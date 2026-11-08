import XCTest
@testable import OpenAGI

final class WorkspaceLayoutTests: XCTestCase {
    func testBookPlacesWorkspaceAndOptionalChatOnOppositePages() {
        let size = CGSize(width: 1000, height: 800)
        let fold = CGRect(x: 475, y: 0, width: 50, height: 800)
        let regions = WorkspaceRegions(size: size, division: fold, showsChat: true)
        XCTAssertEqual(regions.primary, CGRect(x: 0, y: 0, width: 475, height: 800))
        XCTAssertEqual(regions.chat, CGRect(x: 525, y: 0, width: 475, height: 800))
        let rtl = WorkspaceRegions(size: size, division: fold, showsChat: true, rightToLeft: true)
        XCTAssertEqual(rtl.primary, regions.chat)
        XCTAssertEqual(rtl.chat, regions.primary)
    }

    func testTabletopKeepsWorkspaceAboveFoldAndChatBelow() {
        let regions = WorkspaceRegions(size: .init(width: 700, height: 1000),
            division: .init(x: 0, y: 475, width: 700, height: 50), showsChat: true)
        XCTAssertEqual(regions.primary, CGRect(x: 0, y: 0, width: 700, height: 475))
        XCTAssertEqual(regions.chat, CGRect(x: 0, y: 525, width: 700, height: 475))
    }

    func testClosingChatRestoresWholeWindowInEveryPose() {
        let size = CGSize(width: 700, height: 1000)
        for division in [nil, CGRect(x: 0, y: 475, width: 700, height: 50)] {
            let regions = WorkspaceRegions(size: size, division: division, showsChat: false)
            XCTAssertEqual(regions.primary, CGRect(origin: .zero, size: size))
            XCTAssertEqual(regions.chat, .zero)
        }
    }

    func testSplitWindowIgnoresDivisionOutsideItsBoundsAndCapsChatWidth() {
        let size = CGSize(width: 800, height: 700)
        let absent = WorkspaceRegions(size: size, division: nil, showsChat: true)
        let outside = WorkspaceRegions(size: size, division: .init(x: 900, y: 0, width: 40, height: 800), showsChat: true)
        XCTAssertEqual(outside.primary, absent.primary)
        XCTAssertEqual(outside.chat, absent.chat)
        let wide = WorkspaceRegions(size: .init(width: 1600, height: 900), division: nil, showsChat: true)
        XCTAssertEqual(wide.chat.width, 480)
        XCTAssertEqual(wide.primary.maxX, wide.chat.minX)
    }
}
