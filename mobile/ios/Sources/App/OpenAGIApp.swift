import BackgroundTasks
import SwiftUI

@main
struct OpenAGIApp: App {
    static let refreshTaskIdentifier = "sh.openagi.refresh"

    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var credentials: Credentials?
    @State private var pendingPairing: PairingPayload?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        _credentials = State(initialValue: Credentials.load())
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
                if let credentials {
                    RootTabView(
                        credentials: credentials,
                        incomingPairing: pendingPairing,
                        onDismissIncomingPairing: { pendingPairing = nil },
                        onRevoked: { self.credentials = nil }
                    )
                } else {
                    // `.id` forces a fresh PairingView (and fresh @State) whenever a
                    // new deep link arrives; SwiftUI would otherwise keep the
                    // already-appeared view's state and ignore a later prefill.
                    PairingView(
                        prefillServer: pendingPairing?.serverURL,
                        prefillCode: pendingPairing?.code,
                        onPaired: {
                            self.credentials = Credentials.load()
                            // Spent. Left set, it would reach RootTabView as an
                            // "incoming" link and immediately ask to switch away
                            // from the pairing it just made.
                            pendingPairing = nil
                        }
                    )
                    .id(pendingPairing?.code ?? "")
                }
            }
            .onOpenURL { url in
                // The Live Activity's tap target.
                if url.scheme == "openagi", url.host == "supervisor" {
                    PushRouter.shared.openSupervisor()
                    return
                }
                guard let payload = PairingPayload(url: url) else { return }
                pendingPairing = payload
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
        guard let credentials else { return }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        Task { _ = await RefreshCoordinator(client: client).refresh() }
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

        guard let credentials = Credentials.load() else {
            task.setTaskCompleted(success: false)
            return
        }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        let refreshTask = Task {
            let outcome = await RefreshCoordinator(client: client).refresh()
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
