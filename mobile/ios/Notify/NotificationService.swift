import Foundation
import UserNotifications

// OpenAGINotify: rewrites a supervisor alert on the phone. The relay can only
// send generic text ("Supervisor needs you") plus the sealed envelope; this
// opens the envelope with the push key and puts the real question, its
// answer buttons and the exact option strings onto the notification. Any
// failure (no key yet, a key from another pairing, a tampered payload) leaves
// the generic text: the alert still arrives and a tap still opens Supervisor.
// An approval envelope gets its summary and the Approve/Deny category instead.
//
// The mapping itself is SupervisorPushContent.alert, pinned by the app's
// tests; this file only applies it.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    // Guarded by `lock`: the content handler must run exactly once, either
    // from the normal path or from the expiry callback.
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.withLock {
            self.contentHandler = contentHandler
            self.bestAttempt = request.content
        }
        let key = PushKeyStore.load()
        if let approval = ApprovalPushContent.approval(userInfo: request.content.userInfo, key: key),
           let content = request.content.mutableCopy() as? UNMutableNotificationContent {
            deliver(approval: approval, content: content)
            return
        }
        guard let alert = SupervisorPushContent.alert(userInfo: request.content.userInfo, key: key),
              let content = request.content.mutableCopy() as? UNMutableNotificationContent
        else {
            finish(with: request.content)
            return
        }
        content.title = alert.title
        content.body = alert.body
        content.categoryIdentifier = alert.categoryIdentifier
        var userInfo = content.userInfo
        for (key, value) in alert.userInfo { userInfo[key] = value }
        content.userInfo = userInfo
        let rewritten = content.copy() as? UNNotificationContent ?? content
        lock.withLock { bestAttempt = rewritten }

        // Content is not Sendable; it is built here and only read again by
        // the one completion below.
        let delivered = UncheckedSendableBox(value: rewritten)
        SupervisorCategories.register(SupervisorCategories.category(for: alert)) { [self] in
            finish(with: delivered.value)
        }
    }

    // An approval (envelope kind `approval`, ApprovalPushContent.approval):
    // its summary, and the fixed Approve/Deny category. Registered again here
    // in case the app has not run since an update added it.
    private func deliver(approval: ApprovalPushContent.Approval, content: UNMutableNotificationContent) {
        content.title = approval.title
        content.body = approval.body
        content.categoryIdentifier = ApprovalPushContent.category
        content.threadIdentifier = "approvals"
        var userInfo = content.userInfo
        for (key, value) in approval.userInfo { userInfo[key] = value }
        content.userInfo = userInfo
        let rewritten = content.copy() as? UNNotificationContent ?? content
        lock.withLock { bestAttempt = rewritten }
        let delivered = UncheckedSendableBox(value: rewritten)
        SupervisorCategories.register(SupervisorCategories.approval()) { [self] in
            finish(with: delivered.value)
        }
    }

    // The system gives the extension about 30 seconds. Running out while
    // registering the category still delivers the decrypted text.
    override func serviceExtensionTimeWillExpire() {
        let content = lock.withLock { bestAttempt }
        if let content { finish(with: content) }
    }

    private func finish(with content: UNNotificationContent) {
        let handler = lock.withLock { () -> ((UNNotificationContent) -> Void)? in
            defer { contentHandler = nil }
            return contentHandler
        }
        handler?(content)
    }
}
