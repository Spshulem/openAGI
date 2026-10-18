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
                    .id(pendingPairing?.code ?? "")
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
            .environment(session)
            .onOpenURL { url in
                // The Live Activity's tap target.
                if url.scheme == "openagi", url.host == "supervisor" {
                    PushRouter.shared.openSupervisor()
                    return
                }
                guard let payload = PairingPayload(url: url) else { return }
                pendingPairing = payload
                if session.phase == .welcome { session.chooseServer() }
            }
            .onChange(of: scenePhase) { _, newPhase in
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
        Task { _ = await RefreshCoordinator(client: client).refresh() }
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

        let refreshTask = Task { @MainActor in
            // Phone-only mode: the daemon must be up before anything can
            // refresh from it, and its due cron jobs run while it is.
            let credentials = AppMode.current == .onPhone
                ? try? await PhoneAgent.bringUp()
                : Credentials.load()
            guard let credentials else {
                task.setTaskCompleted(success: false)
                return
            }
            let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
            let outcome = await RefreshCoordinator(client: client).refresh()
            if credentials.isEmbedded {
                await DailyDigestNotifier.refresh(client: client)
            } else if outcome != .offline && outcome != .unauthorized {
                await OfflineCopy.shared.sync(from: client)
            }
            // A push registration that failed earlier retries here too.
            await PushRegistrar.shared.sync()
            switch outcome {
            case .updated, .unchanged:
                task.setTaskCompleted(success: true)
            case .unauthorized, .offline:
                task.setTaskCompleted(success: false)
            }
        }
        task.expirationHandler = {
            refreshTask.cancel()
        }
    }
}
