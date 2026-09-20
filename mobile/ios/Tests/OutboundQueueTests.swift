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
        // Hardcode the cap (5) rather than reading OutboundQueue.maxAttempts:
        // the implementation checks against that same symbol, so looping on
        // it would pass for any cap value, including a regression.
        let queue = OutboundQueue(directory: dir)
        let op = PendingOp(kind: .completeTask("task_4"))
        try queue.enqueue(op)
        for _ in 0..<4 { try queue.recordAttempt(id: op.id) }
        XCTAssertEqual(queue.all().count, 1, "an op must survive short of the cap (4 attempts)")
        try queue.recordAttempt(id: op.id)
        XCTAssertTrue(queue.all().isEmpty, "an op that keeps failing must be dropped on its 5th attempt")
    }

    func testConcurrentEnqueuesAgainstTheSameFileDoNotLoseUpdates() throws {
        // A true two-process test isn't possible inside an XCTest bundle. This
        // races many threads through the exact read-modify-write sequence
        // (read the outbox, append one op, write it back) that the widget's
        // AppIntent and the app's refresh coordinator perform from different
        // processes on the same file. It proves the coordinated block
        // serializes this in-process race so no enqueue is lost; it does NOT
        // prove cross-process behavior, which a unit test bundle cannot host.
        let queue = OutboundQueue(directory: dir)
        let iterations = 25
        DispatchQueue.concurrentPerform(iterations: iterations) { index in
            try? queue.enqueue(PendingOp(kind: .completeTask("task_\(index)")))
        }
        XCTAssertEqual(queue.all().count, iterations, "a concurrent read-modify-write must not drop an enqueue")
    }
}
