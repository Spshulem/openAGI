import BackgroundTasks
import SwiftUI

@main
struct OpenAGIApp: App {
    static let refreshTaskIdentifier = "sh.openagi.refresh"

    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var session = AppSession.shared
    @State private var pendingPairing: PairingPayload?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskIdentifier, using: nil) { task in
            guard let appRefreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Self.handleBackgroundRefresh(appRefreshTask)
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if UITestProtocol.isEnabled {
                    UITestRoot()
                } else if ProcessInfo.processInfo.arguments.contains("--local-agent-acceptance") {
                    LocalAgentAcceptanceView()
                } else {
                    sessionContent
                }
                #else
                sessionContent
                #endif
            }
            .environment(session)
            .onOpenURL { url in
                #if DEBUG
                if UITestProtocol.isEnabled || ProcessInfo.processInfo.arguments.contains("--local-agent-acceptance") { return }
                #endif
                if WebSignIn.handleCallback(url) { return }
                // The Live Activity's tap target.
                if url.scheme == "openagi", url.host == "supervisor" {
                    PushRouter.shared.openSupervisor(threadKey: SupervisorLink.threadKey(in: url))
                    return
                }
                guard let payload = PairingPayload(url: url) else { return }
                pendingPairing = payload
                if session.phase == .welcome { session.chooseServer() }
            }
            .onChange(of: scenePhase) { _, newPhase in
                #if DEBUG
                if UITestProtocol.isEnabled || ProcessInfo.processInfo.arguments.contains("--local-agent-acceptance") { return }
                #endif
                switch newPhase {
                case .active:
                    refreshNow()
                case .background:
                    Self.scheduleBackgroundRefresh()
                default:
                    break
                }
            }
        }
    }

    @ViewBuilder
    private var sessionContent: some View {
        switch session.phase {
        case .welcome:
            WelcomeView()
        case .phoneSetup:
            PhoneSetupView()
        case .phoneStarting:
            PhoneStartingView(failure: nil)
                .task { await session.startPhone() }
        case .phoneFailed(let message):
            PhoneStartingView(failure: message)
        case .pairing:
            // `.id` forces a fresh PairingView (and fresh @State) whenever a
            // new deep link arrives; SwiftUI would otherwise keep the
            // already-appeared view's state and ignore a later prefill.
            PairingView(
                prefillServer: pendingPairing?.serverURL,
                prefillCode: pendingPairing?.code,
                onCancel: { session.goBack() },
                onPaired: {
                    // Spent. Left set, it would reach RootTabView as an
                    // "incoming" link and immediately ask to switch away
                    // from the pairing it just made.
                    pendingPairing = nil
                    session.paired()
                }
            )
            .id(pendingPairing)
        case .ready(let credentials):
            RootTabView(
                credentials: credentials,
                initialTab: session.initialTab,
                incomingPairing: pendingPairing,
                onDismissIncomingPairing: { pendingPairing = nil },
                onRevoked: { session.revoked() }
            )
            // A different daemon is a different model, stream and cache.
            .id(credentials.server.absoluteString + credentials.nodeID)
        }
    }

    private func refreshNow() {
        guard case .ready(let credentials) = session.phase else { return }
        // iOS drops the model bridge's socket while the app is suspended.
        if credentials.isEmbedded {
            Task {
                await PhoneAgent.connectModel()
                await PhoneAgent.refreshDigests(credentials)
            }
        }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        // RootTabView refreshes through its AppModel so the visible tabs
        // observe the result, rather than only updating the on-disk snapshot.
        // Keep the offline copy of the Mac agent fresh (throttled).
        if !credentials.isEmbedded { Task { await OfflineCopy.shared.sync(from: client) } }
        Task { await PushRegistrar.shared.sync() }
        Task { await SupervisorAnswerSender.clearClosedAlerts(client: client) }
    }

    // MARK: - Background refresh

    private static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    // Reschedules itself immediately: the system only wakes this once per
    // request, so a completed (or failed, or expired) run must ask for the
    // next one right away or the phone stops getting background refreshes.
    private static func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        scheduleBackgroundRefresh()

        let completion = BackgroundRefreshCompletion { success in task.setTaskCompleted(success: success) }
        let refreshTask = Task { @MainActor in
            guard !Task.isCancelled else { completion.finish(success: false); return }
            // Phone-only mode: the daemon must be up before anything can
            // refresh from it, and its due cron jobs run while it is.
            let credentials = AppMode.current == .onPhone
                ? try? await PhoneAgent.bringUp()
                : Credentials.load()
            guard !Task.isCancelled, let credentials else {
                completion.finish(success: false)
                return
            }
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            let outcome = await RefreshCoordinator(client: client).refresh()
            guard !Task.isCancelled else { completion.finish(success: false); return }
            if credentials.isEmbedded {
                await DailyDigestNotifier.refresh(client: client)
            } else {
                switch outcome {
                case .updated, .unchanged: await OfflineCopy.shared.sync(from: client)
                default: break
                }
            }
            guard !Task.isCancelled else { completion.finish(success: false); return }
            // A push registration that failed earlier retries here too.
            await PushRegistrar.shared.sync()
            guard !Task.isCancelled else { completion.finish(success: false); return }
            switch outcome {
            case .updated, .unchanged:
                completion.finish(success: true)
            case .unauthorized, .offline, .mainUnavailable:
                completion.finish(success: false)
            }
        }
        task.expirationHandler = {
            refreshTask.cancel()
            completion.finish(success: false)
        }
    }
}

// Expiration and the async work can race. Report completion once, including
// immediately on expiration rather than after a cancelled network call exits.
final class BackgroundRefreshCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completion: (@Sendable (Bool) -> Void)?

    init(_ completion: @escaping @Sendable (Bool) -> Void) { self.completion = completion }

    func finish(success: Bool) {
        let callback = lock.withLock {
            defer { completion = nil }
            return completion
        }
        callback?(success)
    }
}
