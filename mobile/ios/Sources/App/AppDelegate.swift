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
        let userInfo = response.notification.request.content.userInfo
        let approval = ApprovalAction.from(actionIdentifier: response.actionIdentifier,
                                           defaultActionIdentifier: UNNotificationDefaultActionIdentifier,
                                           userInfo: userInfo)
        let action = SupervisorAnswerAction.from(actionIdentifier: response.actionIdentifier,
                                                 defaultActionIdentifier: UNNotificationDefaultActionIdentifier,
                                                 userInfo: userInfo,
                                                 userText: (response as? UNTextInputNotificationResponse)?.userText)
        let questionID = (userInfo[SupervisorPushContent.questionIdKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let threadKey = (userInfo[SupervisorPushContent.threadKeyKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let notificationID = response.notification.request.identifier
        let digestTab = DailyDigestNotifier.tab(for: userInfo)
        let done = UncheckedSendableBox(value: completionHandler)
        Task { @MainActor in
            // Phone-only mode's morning plan and evening recap.
            if let digestTab {
                PushRouter.shared.wantsTab = digestTab
                done.value()
                return
            }
            // An approval alert, or the result that replaced one.
            switch approval {
            case .open?:
                PushRouter.shared.wantsTab = .inbox
                done.value()
                return
            case let decision?:
                await ApprovalActionSender.send(decision, notificationID: notificationID)
                done.value()
                return
            case nil:
                break
            }
            switch action {
            case .open?:
                PushRouter.shared.openSupervisor(questionID: questionID, threadKey: threadKey)
            case let action?:
                await SupervisorAnswerSender.send(action, notificationID: notificationID)
            case nil:
                break
            }
            done.value()
        }
    }
}

// A notification tap asks for the Supervisor tab and, when present, deep-links
// straight into the exact question/thread context sheet. RootTabView watches
// this, including on a cold launch where the tap arrives before it exists.
@Observable
@MainActor
final class PushRouter {
    static let shared = PushRouter()
    var wantsSupervisor = false
    var pendingQuestionID: String?
    var pendingThreadKey: String?
    // Any other tab a notification tap asks for.
    var wantsTab: AppTab?
    // Set by every Supervisor link (notification, Live Activity, Shortcut):
    // whatever sheet is up closes once, so an overview request is not hidden
    // behind an older session and a linked one can present.
    var dismissesSheets = false

    func openSupervisor(questionID: String? = nil, threadKey: String? = nil) {
        dismissesSheets = true
        if let q = questionID?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty {
            pendingQuestionID = q
        }
        if let t = threadKey?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            pendingThreadKey = t
        }
        wantsSupervisor = true
    }
}
