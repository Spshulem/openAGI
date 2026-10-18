import Observation
import UIKit
import UserNotifications

// The UIKit half SwiftUI's App has no hooks for: the APNs device token, and
// the notification-center delegate, which must be set before launch finishes
// or a tapped answer button that cold-launches the app is lost.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        if UITestProtocol.isEnabled { return true }
        #endif
        UNUserNotificationCenter.current().delegate = self
        // A paired phone refreshes its token every launch (Apple's advice:
        // tokens can change). Permission is asked later, by PushRegistrar.
        if Credentials.load() != nil { application.registerForRemoteNotifications() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.shared.didRegister(deviceToken: deviceToken)
    }

    // No team / no aps-environment (the default ad-hoc build) lands here.
    // Nothing to do: the app works without push.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // In the foreground a supervisor alert still shows as a banner: the
    // owner may be on another tab.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = SupervisorAnswerAction.from(actionIdentifier: response.actionIdentifier,
                                                 defaultActionIdentifier: UNNotificationDefaultActionIdentifier,
                                                 userInfo: response.notification.request.content.userInfo)
        let notificationID = response.notification.request.identifier
        let digestTab = DailyDigestNotifier.tab(for: response.notification.request.content.userInfo)
        let done = UncheckedSendableBox(value: completionHandler)
        Task { @MainActor in
            // Phone-only mode's morning plan and evening recap.
            if let digestTab {
                PushRouter.shared.wantsTab = digestTab
                done.value()
                return
            }
            switch action {
            case .open?:
                PushRouter.shared.openSupervisor()
            case let action?:
                await SupervisorAnswerSender.send(action, notificationID: notificationID)
            case nil:
                break
            }
            done.value()
        }
    }
}

// A notification tap asks for the Supervisor tab. RootTabView watches this,
// including on a cold launch where the tap arrives before it exists.
@Observable
@MainActor
final class PushRouter {
    static let shared = PushRouter()
    var wantsSupervisor = false
    // Any other tab a notification tap asks for.
    var wantsTab: AppTab?

    func openSupervisor() { wantsSupervisor = true }
}
