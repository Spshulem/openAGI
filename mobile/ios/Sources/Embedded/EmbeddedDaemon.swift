import Darwin
import Foundation
import Observation
#if os(iOS)
import UIKit
#endif

// Runs the real OpenAGI daemon inside this app (phone-only mode): Node 22
// from the embedded nodejs-mobile runtime, executing the same src/ as the Mac
// with OPENAGI_PROFILE=mobile, bound to 127.0.0.1. The rest of the app talks
// to it over HTTP exactly as it talks to a Mac.
//
// Node can start only once per process and cannot be restarted in it, so
// this starts it at most once and, if it ever exits, reports that the app
// must be relaunched rather than retrying.
@MainActor
@Observable
final class EmbeddedDaemon {
    static let shared = EmbeddedDaemon()

    enum State: Equatable {
        case idle
        case starting
        case ready(port: Int)
        case failed(String)
    }

    private(set) var state: State = .idle
    private var startTask: Task<Int, Error>?

    nonisolated static let defaultPort = 43210

    // True when this build carries the runtime and the daemon's JavaScript
    // (scripts/fetch-node-runtime.sh was run before building).
    nonisolated static var isBundled: Bool {
        FileManager.default.fileExists(atPath: frameworkPath) && FileManager.default.fileExists(atPath: entryPath)
    }

    nonisolated private static var frameworkPath: String {
        (Bundle.main.privateFrameworksPath ?? "") + "/NodeMobile.framework/NodeMobile"
    }

    nonisolated private static var daemonRoot: String {
        (Bundle.main.resourcePath ?? "") + "/openagi-daemon"
    }

    nonisolated private static var entryPath: String {
        daemonRoot + "/bin/mobile-entry.mjs"
    }

    // Application Support/openagi. Backed up with the device; it is the
    // agent's memory, tasks and history.
    nonisolated static var dataDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("openagi", isDirectory: true)
    }

    var port: Int? {
        if case .ready(let port) = state { return port }
        return nil
    }

    // Starts Node if it isn't running and waits until /health answers.
    // Returns the port. Safe to call repeatedly; every caller shares one start.
    @discardableResult
    func start() async throws -> Int {
        if case .ready(let port) = state { return port }
        if case .failed(let message) = state { throw EmbeddedDaemonError.failed(message) }
        if let startTask { return try await startTask.value }
        state = .starting
        let task = Task { try await Self.launch() }
        startTask = task
        do {
            let port = try await task.value
            EmbeddedLoopback.port = port
            state = .ready(port: port)
            return port
        } catch {
            let message = (error as? EmbeddedDaemonError)?.message ?? error.localizedDescription
            state = .failed(message)
            throw EmbeddedDaemonError.failed(message)
        }
    }

    fileprivate func nodeExited(code: Int32) {
        EmbeddedLoopback.port = nil
        state = .failed("OpenAGI stopped (exit \(code)). Close and reopen the app to restart it.")
    }

    private static func launch() async throws -> Int {
        guard isBundled else { throw EmbeddedDaemonError.failed("This build doesn't include the on-phone runtime.") }
        guard let handle = dlopen(frameworkPath, RTLD_NOW), let symbol = dlsym(handle, "node_start") else {
            throw EmbeddedDaemonError.failed("Couldn't load the on-phone runtime: \(String(cString: dlerror()))")
        }
        typealias NodeStart = @convention(c) (Int32, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> Int32
        let nodeStart = unsafeBitCast(symbol, to: NodeStart.self)

        let secrets = try EmbeddedSecrets.loadOrCreate()
        let dataDir = dataDirectory
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let port = isPortFree(defaultPort) ? defaultPort : freePort()

        // Node reads its environment once, at start.
        setenv("OPENAGI_DATA_DIR", dataDir.path, 1)
        setenv("HOME", dataDir.path, 1)
        setenv("OPENAGI_AUTH_TOKEN", secrets.ownerToken, 1)
        setenv("PORT", String(port), 1)
        setenv("OPENAGI_TIME_ZONE", TimeZone.current.identifier, 1)
        setenv("TZ", TimeZone.current.identifier, 1)
        FileManager.default.changeCurrentDirectoryPath(daemonRoot)

        let argv = NodeArguments(["node", "--jitless", entryPath])
        let thread = Thread {
            let code = argv.withPointers { nodeStart($0, $1) }
            Task { @MainActor in EmbeddedDaemon.shared.nodeExited(code: code) }
        }
        // Node's default stack is too deep for a secondary thread's 512 KB.
        thread.stackSize = 16 * 1024 * 1024
        thread.name = "openagi-node"
        thread.start()

        try await waitForHealth(port: port)
        return port
    }

    private static func waitForHealth(port: Int) async throws {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if case .failed(let message) = await EmbeddedDaemon.shared.state { throw EmbeddedDaemonError.failed(message) }
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            if let (_, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                return
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw EmbeddedDaemonError.failed("OpenAGI didn't start in time.")
    }

    // MARK: - The app's own credential on this daemon

    // The mobile-node credential the rest of the app uses, enrolling this app
    // with its own daemon the first time (the same enrollment a Mac's
    // pair-phone code drives, minted here with the owner token).
    func localCredentials() async throws -> Credentials {
        let port = try await start()
        var secrets = try EmbeddedSecrets.loadOrCreate()
        if let existing = secrets.localCredentials(port: port), await Self.nodeCredentialWorks(existing) {
            return existing
        }
        let server = URL(string: "http://127.0.0.1:\(port)")!
        let codeResponse = try await ownerRequest(path: "/nodes/enrollment-code", body: ["platform": "mobile"])
        guard let code = codeResponse["code"] as? String else { throw DaemonError.malformedResponse }
        let enrollment = try await DaemonClient.enroll(
            server: server, code: code, nodeID: "mobile:" + UUID().uuidString,
            nodeToken: PairingView.generateNodeToken(), name: Self.deviceName()
        )
        secrets.nodeID = enrollment.node.id
        secrets.nodeToken = enrollment.nodeToken
        try secrets.save()
        return Credentials(server: server, nodeID: enrollment.node.id, token: enrollment.nodeToken)
    }

    // An owner-token call to the embedded daemon: setup-only routes such as
    // enrollment and the agent's persona, which a node credential can't reach.
    @discardableResult
    func ownerRequest(path: String, body: [String: Any]) async throws -> [String: Any] {
        let port = try await start()
        guard let secrets = EmbeddedSecrets.load() else { throw DaemonError.unauthorized }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(secrets.ownerToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw DaemonError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200...299: return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        case 401, 403: throw DaemonError.unauthorized
        default: throw DaemonError.server(http.statusCode)
        }
    }

    // A saved node credential outlives the data dir when the app is deleted
    // and reinstalled (the Keychain survives, Application Support does not).
    private static func nodeCredentialWorks(_ credentials: Credentials) async -> Bool {
        var request = URLRequest(url: credentials.server.appending(path: "/tasks"))
        request.timeoutInterval = 5
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        request.setValue(credentials.nodeID, forHTTPHeaderField: "X-OpenAGI-Node-ID")
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    private static func deviceName() -> String {
        #if os(iOS)
        UIDevice.current.name
        #else
        "iPhone"
        #endif
    }
}

enum EmbeddedDaemonError: Error, LocalizedError {
    case failed(String)

    var message: String {
        switch self {
        case .failed(let message): return message
        }
    }

    var errorDescription: String? { message }
}

// Node keeps pointers into argv for the life of the process, so the strings
// live in one buffer that is never freed.
private final class NodeArguments: @unchecked Sendable {
    private let count: Int32
    private let argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>

    init(_ args: [String]) {
        count = Int32(args.count)
        let total = args.reduce(0) { $0 + $1.utf8.count + 1 }
        let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: total)
        argv = .allocate(capacity: args.count + 1)
        var offset = 0
        for (index, arg) in args.enumerated() {
            let slot = buffer + offset
            arg.withCString { _ = strcpy(slot, $0) }
            argv[index] = slot
            offset += arg.utf8.count + 1
        }
        argv[args.count] = nil
    }

    func withPointers<T>(_ body: (Int32, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> T) -> T {
        body(count, argv)
    }
}

private func isPortFree(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var address = loopbackAddress(port: port)
    return withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
    }
}

// Asks the kernel for an unused loopback port.
private func freePort() -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return EmbeddedDaemon.defaultPort + 1 }
    defer { close(fd) }
    var address = loopbackAddress(port: 0)
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0
        }
    }
    return bound ? Int(UInt16(bigEndian: address.sin_port)) : EmbeddedDaemon.defaultPort + 1
}

private func loopbackAddress(port: Int) -> sockaddr_in {
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port).bigEndian)
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    return address
}
