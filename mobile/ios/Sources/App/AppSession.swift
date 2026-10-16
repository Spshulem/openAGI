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
        let mode = AppMode.resolved(hasCredentials: credentials != nil)
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

    func choosePhone() { phase = .phoneSetup }
    func chooseServer() { phase = .pairing }

    // Back from pairing or phone setup to wherever the person came from.
    func goBack() {
        if mode == .onPhone, let credentials = Credentials.load(), credentials.isEmbedded {
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
        await connectModel()
        return credentials
    }

    // Called at bring-up and on every return to the foreground: iOS drops
    // the socket while the app is suspended.
    static func connectModel() async {
        guard let port = EmbeddedDaemon.shared.port, let secrets = EmbeddedSecrets.load() else { return }
        await DeviceModelBridge.shared.connect(port: port, ownerToken: secrets.ownerToken, backend: OnDeviceModelStatus.backend())
    }
}
