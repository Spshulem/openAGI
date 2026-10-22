import Foundation
import Observation

// What the app is showing at the top level, and the moves between them.
//
// Onboarding is phone-first, in two phases: a new person starts with the
// agent running on this iPhone (no Mac, no account), and can connect it to
// a server later from Settings. Pairing with a Mac straight away stays one
// tap away for people who already run one.
@MainActor
@Observable
final class AppSession {
    static let shared = AppSession()

    enum Phase: Equatable {
        case welcome
        case phoneSetup
        case pairing
        case phoneStarting
        case phoneFailed(String)
        case ready(Credentials)
    }

    private(set) var phase: Phase
    private(set) var mode: AppMode?
    // The tab a freshly set-up agent opens on.
    private(set) var initialTab: AppTab = .today

    init() {
        let credentials = Credentials.load()
        let mode = AppMode.resolved(credentials: credentials)
        self.mode = mode
        switch mode {
        case .onPhone?: phase = .phoneStarting
        case .server?: phase = credentials.map(Phase.ready) ?? .pairing
        case nil: phase = .welcome
        }
    }

    // True once an agent exists on this iPhone, even while the app is
    // pointed at a server.
    var hasPhoneAgent: Bool { EmbeddedSecrets.load()?.nodeID != nil }

    var canRunOnPhone: Bool { EmbeddedDaemon.isBundled }

    // The server credential kept aside while the app uses the iPhone agent.
    var serverBackup: Credentials? { Credentials.load(from: .server) }

    func choosePhone() { phase = .phoneSetup }
    func chooseServer() { phase = .pairing }

    // Back from pairing or phone setup to wherever the person came from.
    func goBack(queue: OutboundQueue = OutboundQueue(), parkedQueue: OutboundQueue = .parkedForServer()) {
        if mode == .server, let backup = serverBackup {
            try? backup.save()
            try? parkedQueue.move(to: queue)
            phase = .ready(backup)
        } else if mode == .server, let credentials = Credentials.load() {
            try? parkedQueue.move(to: queue)
            phase = .ready(credentials)
        } else if mode == .onPhone, let credentials = Credentials.load(), credentials.isEmbedded {
            phase = .ready(credentials)
        } else if mode == .onPhone {
            Task { await startPhone() }
        } else {
            phase = .welcome
        }
    }

    func finishPhoneSetup(_ credentials: Credentials) {
        AppMode.current = .onPhone
        mode = .onPhone
        initialTab = .chat
        phase = .ready(credentials)
    }

    // From a server, Settings' "Try the agent on this iPhone": the server's
    // credential is set aside first, because bringing the iPhone agent up
    // makes its credential the active one.
    func tryPhone() {
        if let current = Credentials.load(), !current.isEmbedded { try? current.save(to: .server) }
        if hasPhoneAgent {
            Task { await startPhone() }
        } else {
            phase = .phoneSetup
        }
    }

    // Back to the Mac. What was added here while away goes to it first; if
    // the Mac still can't be reached, this throws and nothing switches.
    // The current screen's model is detached only once the Mac has the work,
    // so a failed attempt leaves the iPhone agent exactly as it was.
    func switchBackToServer(detaching current: AppModel? = nil) async throws -> Int {
        guard let backup = serverBackup else {
            current?.detach()
            chooseServer()
            return 0
        }
        let client = DaemonClient(server: backup.server, nodeID: backup.nodeID, token: backup.token)
        let sent = try await OfflineCopy.shared.sendOfflineWork(to: client)
        current?.detach()
        // The Mac's own queued work, parked when the app left it.
        try? OutboundQueue.parkedForServer().move(to: OutboundQueue())
        try backup.save()
        paired()
        Task { await OfflineCopy.shared.sync(from: client, force: true) }
        return sent
    }

    // The Mac is unreachable: continue on this iPhone with the offline copy.
    // No onboarding here: the phone agent takes the Mac agent's name and
    // instructions from the offline copy.
    func continueOnPhone() {
        if let current = Credentials.load(), !current.isEmbedded { try? current.save(to: .server) }
        Task { await startPhone() }
    }

    // Launch (and "Use this iPhone"): bring the embedded daemon up and point
    // the app at it.
    func startPhone() async {
        AppMode.current = .onPhone
        mode = .onPhone
        phase = .phoneStarting
        do {
            phase = .ready(try await PhoneAgent.bringUp())
        } catch {
            phase = .phoneFailed(error.localizedDescription)
        }
    }

    func paired() {
        // The active credential is now the server's; no copy is needed, and
        // any parked work has been restored (switch back) or belongs to a
        // server this phone no longer uses (a new pairing).
        Credentials.clear(.server)
        try? OutboundQueue.parkedForServer().clear()
        // A Mac or server sends its own plan and recap.
        DailyDigestNotifier.cancelAll()
        AppMode.current = .server
        mode = .server
        initialTab = .today
        Task { await DeviceModelBridge.shared.disconnect() }
        phase = Credentials.load().map(Phase.ready) ?? .pairing
    }

    // The active credential stopped working. On a server that means
    // unpaired; on this iPhone the app enrolls with its own daemon again.
    func revoked() {
        if mode == .onPhone {
            Task { await startPhone() }
        } else {
            Credentials.clear(.server)
            try? OutboundQueue.parkedForServer().clear()
            AppMode.current = nil
            mode = nil
            phase = .welcome
        }
    }
}

// The agent on this iPhone: the embedded daemon plus the model bridge.
@MainActor
enum PhoneAgent {
    static func bringUp() async throws -> Credentials {
        let credentials = try await EmbeddedDaemon.shared.localCredentials()
        try credentials.save()
        AppMode.current = .onPhone
        await connectModel()
        Task { await refreshDigests(credentials) }
        return credentials
    }

    static func refreshDigests(_ credentials: Credentials) async {
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        await DailyDigestNotifier.refresh(client: client)
    }

    // Called at bring-up and on every return to the foreground: iOS drops
    // the socket while the app is suspended.
    static func connectModel() async {
        guard let port = EmbeddedDaemon.shared.port, let secrets = EmbeddedSecrets.load() else { return }
        await DeviceModelBridge.shared.connect(port: port, ownerToken: secrets.ownerToken,
            backend: OnDeviceModelStatus.backend(), availability: OnDeviceModelStatus.current().availabilityName)
    }
}
