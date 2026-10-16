import XCTest
@testable import OpenAGI

final class OfflineCopyTests: XCTestCase {
    @MainActor
    func testItemCountAddsMessagesTasksAndMemories() {
        let work = Data(#"{"version":1,"messages":{"agent":[{},{}],"supervisor":[{}]},"tasks":[{}],"memories":[{},{},{}]}"#.utf8)
        XCTAssertEqual(OfflineCopy.itemCount(work), 7)
        XCTAssertEqual(OfflineCopy.itemCount(Data(#"{"version":1,"messages":{"agent":[],"supervisor":[]},"tasks":[],"memories":[]}"#.utf8)), 0)
        XCTAssertEqual(OfflineCopy.itemCount(Data("nope".utf8)), 0)
    }
}
