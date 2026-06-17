import Foundation
import UserNotifications

// userInfo key tagging a notification as belonging to the outreach feed. File
// scope (not MainActor-isolated) so the nonisolated detector below can read it.
private let outreachUserInfoKey = "outreachId"

// Presents proactive-outreach items as native notifications with inline action
// buttons, quiet-hours aware.
//
// IMPORTANT — delegate ownership: AppDelegate is already the single
// UNUserNotificationCenterDelegate (it deep-links taps via userInfo["path"]).
// This presenter does NOT take over the delegate. Instead it (1) registers the
// outreach notification categories and (2) exposes `handleAction(...)` /
// `isOutreachResponse(...)` that AppDelegate calls from its existing delegate
// method, so outreach buttons work without clobbering existing notification
// handling.
@MainActor
final class NotificationPresenter {
  static let shared = NotificationPresenter()

  // Register one category per outreach type, each with its inline buttons.
  // The category identifier == the item.type so present() can just set it.
  func registerCategories() {
    func cat(_ id: String, _ actions: [(String, String)]) -> UNNotificationCategory {
      UNNotificationCategory(
        identifier: id,
        actions: actions.map { UNNotificationAction(identifier: $0.0, title: $0.1, options: []) },
        intentIdentifiers: [],
        options: [])
    }
    UNUserNotificationCenter.current().setNotificationCategories([
      cat("stalled-task", [("close", "Close it"), ("keep", "Keep"), ("snooze", "Snooze")]),
      cat("pending-action", [("do", "Do it"), ("dismiss", "Not now")]),
      cat("clarification", [("yes", "Yes"), ("no", "No"), ("in_progress", "In progress")]),
      cat("draft", [("approve", "Approve"), ("dismiss", "Dismiss")]),
      cat("digest", [("review", "Review")])
    ])
  }

  // Quiet-hours-aware. Live decisions notify immediately; digests notify; other
  // non-decision items (drafts/suggestions) just populate the overlay so the
  // banner stream stays low-noise.
  func present(_ item: OutreachItem) {
    // Hold live decisions during quiet hours — they'll show in the next digest
    // and remain in the overlay list regardless.
    if OutreachConsumer.shared.inQuietHours() && item.needsDecision { return }
    guard item.needsDecision || item.type == "digest" else { return }

    let content = UNMutableNotificationContent()
    content.title = item.title
    content.body = item.summary
    content.categoryIdentifier = item.type
    content.userInfo = [outreachUserInfoKey: item.id]
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: item.id, content: content, trigger: nil))
  }

  // True when a tapped notification belongs to the outreach feed.
  nonisolated static func isOutreachResponse(_ response: UNNotificationResponse) -> Bool {
    response.notification.request.content.userInfo[outreachUserInfoKey] is String
  }

  // Handle a tapped notification (button or body). Returns true if it consumed
  // the response (so AppDelegate skips its default path-deeplink handling).
  func handleAction(_ response: UNNotificationResponse) -> Bool {
    guard let id = response.notification.request.content.userInfo[outreachUserInfoKey] as? String else {
      return false
    }
    let action = response.actionIdentifier
    if action == UNNotificationDefaultActionIdentifier || action == "review" {
      // Body tap or the digest "Review" button: open the overlay list.
      OverlayController.shared.show()
      OverlayState.shared.expanded = true
      return true
    }
    if action == UNNotificationDismissActionIdentifier {
      return true
    }
    // An inline action button → forward the decision to the remote main.
    Task { await OutreachConsumer.shared.act(id, action: action) }
    return true
  }
}
