import XCTest
@testable import OpenAGI

final class AppModeTests: XCTestCase {
    @MainActor
    func testReplayingAndCancellingSetupKeepsTheAgentAndQueuedWork() throws {
        let previous = Credentials.load()
        let previousBackup = Credentials.load(from: .server)
        let previousMode = AppMode.current
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            Credentials.clear(); Credentials.clear(.server)
            try? previous?.save(); try? previousBackup?.save(to: .server)
            AppMode.current = previousMode
            try? FileManager.default.removeItem(at: directory)
        }
        let queue = OutboundQueue(directory: directory)
        let parked = OutboundQueue.parkedForServer(directory: directory)
        let pending = PendingOp(kind: .completeTask("offline-task"), createdAt: Date(timeIntervalSince1970: 1_700_000_000))
        try queue.enqueue(pending)
        for (url, mode) in [("https://daemon.example.com", AppMode.server), ("http://127.0.0.1:12345", AppMode.onPhone)] {
            let credentials = Credentials(server: URL(string: url)!, nodeID: "mobile:replay", token: "synthetic-token")
            try credentials.save()
            Credentials.clear(.server)
            AppMode.current = mode
            let session = AppSession()
            let store = SnapshotStore(directory: directory)
            let fixture = URL(filePath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appending(path: "fixtures/summary-populated.json")
            let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: Data(contentsOf: fixture))
            _ = try store.storeFresh(summary: summary, etag: "offline-replay")
            for thread in ["agent", "supervisor"] {
                ChatHistoryStore(thread: thread, directory: directory).save(nodeID: credentials.nodeID, entries: [
                    SavedChatEntry(id: UUID(), role: "user", at: Date(), text: "Saved \(thread) message")
                ])
            }
            let model = AppModel(credentials: credentials, store: store, queue: queue, chatDirectory: directory)
            session.restartOnboarding(from: model)
            XCTAssertEqual(session.phase, .welcome)
            XCTAssertEqual(Credentials.load(), credentials)
            XCTAssertEqual(AppMode.current, mode)
            session.goBack(queue: queue, parkedQueue: parked)
            XCTAssertEqual(session.phase, .ready(credentials))
            XCTAssertEqual(Credentials.load(), credentials)
            XCTAssertEqual(queue.all(), [pending])
            XCTAssertEqual(store.load()?.etag, "offline-replay")
            for thread in ["agent", "supervisor"] {
                XCTAssertEqual(ChatHistoryStore(thread: thread, directory: directory)
                    .load(nodeID: credentials.nodeID).map(\.text), ["Saved \(thread) message"])
            }
        }
    }

    @MainActor
    func testCancellingReplayedPhoneSetupRestoresServerAcrossRelaunch() throws {
        let previous = Credentials.load()
        let previousBackup = Credentials.load(from: .server)
        let previousMode = AppMode.current
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            Credentials.clear(); Credentials.clear(.server)
            try? previous?.save(); try? previousBackup?.save(to: .server)
            AppMode.current = previousMode
            try? FileManager.default.removeItem(at: directory)
        }
        let server = Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:server", token: "synthetic-token")
        try server.save()
        AppMode.current = .server
        let queue = OutboundQueue(directory: directory)
        let parked = OutboundQueue.parkedForServer(directory: directory)
        let pending = PendingOp(kind: .completeTask("server-offline-task"), createdAt: Date(timeIntervalSince1970: 1_700_000_000))
        try queue.enqueue(pending)
        let session = AppSession()
        session.restartOnboarding()
        session.choosePhone(queue: queue, parkedQueue: parked)
        XCTAssertEqual(session.phase, .phoneSetup)
        XCTAssertEqual(Credentials.load(from: .server), server)
        XCTAssertTrue(queue.all().isEmpty)
        XCTAssertEqual(parked.all(), [pending])
        // Closing at the first setup screen still leaves the server active.
        // Relaunch must restore its queue even before Cancel can be tapped.
        XCTAssertEqual(AppSession(queue: queue, parkedQueue: parked).phase, .ready(server))
        XCTAssertEqual(queue.all(), [pending])
        XCTAssertTrue(parked.all().isEmpty)
        session.choosePhone(queue: queue, parkedQueue: parked)
        // Phone startup temporarily activates a local credential.
        let local = Credentials(server: URL(string: "http://127.0.0.1:12345")!, nodeID: "mobile:local", token: "synthetic-token")
        try local.save()
        AppMode.current = .onPhone
        XCTAssertEqual(AppSession().phase, .phoneStarting)
        XCTAssertTrue(queue.all().isEmpty, "A relaunched local session must not send the server's completions")
        XCTAssertEqual(parked.all(), [pending])
        session.goBack(queue: queue, parkedQueue: parked)
        XCTAssertEqual(Credentials.load(), server)
        XCTAssertEqual(AppMode.current, .server)
        XCTAssertEqual(AppSession().phase, .ready(server))
        XCTAssertEqual(queue.all(), [pending])
        XCTAssertTrue(parked.all().isEmpty)
    }

    @MainActor
    func testCancellingServerPairingRestoresQueuedWork() throws {
        let previous = Credentials.load()
        let previousBackup = Credentials.load(from: .server)
        let previousMode = AppMode.current
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            Credentials.clear(); Credentials.clear(.server)
            try? previous?.save(); try? previousBackup?.save(to: .server)
            AppMode.current = previousMode
            try? FileManager.default.removeItem(at: directory)
        }
        let credentials = Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:switch", token: "synthetic-token")
        try credentials.save()
        Credentials.clear(.server)
        AppMode.current = .server
        let queue = OutboundQueue(directory: directory)
        let parked = OutboundQueue.parkedForServer(directory: directory)
        // Queue JSON stores whole-second dates; use that precision in the fixture.
        let pending = PendingOp(kind: .completeTask("offline-task"), createdAt: Date(timeIntervalSince1970: 1_700_000_000))
        // Exercise both the legacy active credential and saved-server paths.
        for hasBackup in [false, true] {
            if hasBackup { try credentials.save(to: .server) }
            try parked.enqueue(pending)
            let session = AppSession()
            let selected = URL(string: "https://another.example.com")!
            session.chooseServer(prefillServer: selected)
            XCTAssertEqual(session.phase, .pairing)
            XCTAssertEqual(session.pairingServer, selected)
            XCTAssertEqual(Credentials.load(), credentials, "Selecting a discovered server must preserve the existing credential")
            session.goBack(queue: queue, parkedQueue: parked)
            XCTAssertNil(session.pairingServer)
            XCTAssertEqual(session.phase, .ready(credentials))
            XCTAssertEqual(queue.all(), [pending])
            XCTAssertTrue(parked.all().isEmpty)
            try queue.clear()
        }
    }

    func testInterruptedPhoneSetupStartsEmbeddedDaemon() {
        let local = Credentials(server: URL(string: "http://127.0.0.1:12345")!, nodeID: "mobile:local", token: "test-token")
        XCTAssertEqual(AppMode.resolved(credentials: local, storedMode: nil), .onPhone)
        // Also recover when trying the phone agent from an existing pairing.
        XCTAssertEqual(AppMode.resolved(credentials: local, storedMode: .server), .onPhone)
    }

    func testLegacyPairingAndFreshInstallKeepTheirLaunchBehavior() {
        let remote = Credentials(server: URL(string: "https://daemon.example.com")!, nodeID: "mobile:remote", token: "test-token")
        XCTAssertEqual(AppMode.resolved(credentials: remote, storedMode: nil), .server)
        XCTAssertEqual(AppMode.resolved(credentials: remote, storedMode: .onPhone), .onPhone)
        XCTAssertNil(AppMode.resolved(credentials: nil, storedMode: nil))
        XCTAssertEqual(AppMode.resolved(credentials: nil, storedMode: .server), .server)
    }
}
