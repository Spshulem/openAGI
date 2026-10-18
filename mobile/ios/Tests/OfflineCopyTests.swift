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

    @MainActor
    func testSendsEveryPageAndMarksEachBeforeListingTheNext() async throws {
        let pages = [
            Data(#"{"version":1,"tasks":[{},{}],"truncated":true}"#.utf8),
            Data(#"{"version":1,"messages":{"agent":[{},{},{}]},"memories":[{}],"truncated":false}"#.utf8)
        ]
        var index = 0
        var operations: [String] = []
        let count = try await OfflineCopy.sendPages(next: {
            operations.append("list \(index)")
            return pages[index]
        }, upload: { page in
            XCTAssertEqual(page, pages[index])
            operations.append("upload \(index)")
        }, markSent: { page in
            XCTAssertEqual(page, pages[index])
            operations.append("mark \(index)")
            index += 1
        })
        XCTAssertEqual(count, 6)
        XCTAssertEqual(operations, ["list 0", "upload 0", "mark 0", "list 1", "upload 1", "mark 1"])
    }

    @MainActor
    func testFailedUploadNeverMarksOrContinuesToTheNextPage() async {
        enum UploadFailure: Error { case unavailable }
        var marked = false
        var listed = 0
        do {
            _ = try await OfflineCopy.sendPages(next: {
                listed += 1
                return Data(#"{"version":1,"tasks":[{}],"truncated":true}"#.utf8)
            }, upload: { _ in throw UploadFailure.unavailable }, markSent: { _ in marked = true })
            XCTFail("An incomplete sync must not report success")
        } catch {
            XCTAssertTrue(error is UploadFailure)
        }
        XCTAssertEqual(listed, 1)
        XCTAssertFalse(marked)
    }
}
