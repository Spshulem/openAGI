import XCTest
@testable import OpenAGI

final class OutboundQueueTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(filePath: NSTemporaryDirectory()).appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func testEnqueueAndDrain() throws {
        let queue = OutboundQueue(directory: dir)
        XCTAssertTrue(queue.all().isEmpty)
        let op = PendingOp(kind: .completeTask("task_1"))
        try queue.enqueue(op)
        XCTAssertEqual(queue.all().map(\.kind), [.completeTask("task_1")])
        try queue.remove(id: op.id)
        XCTAssertTrue(queue.all().isEmpty)
    }

    func testOpsSurviveAFreshProcess() throws {
        try OutboundQueue(directory: dir).enqueue(PendingOp(kind: .completeTask("task_2")))
        XCTAssertEqual(OutboundQueue(directory: dir).all().count, 1)
    }

    func testDuplicateCompletionsCollapse() throws {
        // Two taps on the same widget row must not produce two queued POSTs.
        let queue = OutboundQueue(directory: dir)
        try queue.enqueue(PendingOp(kind: .completeTask("task_3")))
        try queue.enqueue(PendingOp(kind: .completeTask("task_3")))
        XCTAssertEqual(queue.all().count, 1)
    }

    func testAttemptsAreCountedAndCapped() throws {
        let queue = OutboundQueue(directory: dir)
        let op = PendingOp(kind: .completeTask("task_4"))
        try queue.enqueue(op)
        for _ in 0..<OutboundQueue.maxAttempts { try queue.recordAttempt(id: op.id) }
        XCTAssertTrue(queue.all().isEmpty, "an op that keeps failing must eventually be dropped")
    }
}
