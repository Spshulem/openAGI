import Foundation
import UserNotifications

// Notification categories for supervisor alerts, shared by the app and the
// notification service extension (project.yml compiles this file into
// both). `setNotificationCategories` replaces the whole set, so every write
// merges into what is already registered instead of replacing it: the app
// registering its base category at launch must not strip the buttons off an
// alert the extension rewrote a minute ago.
enum SupervisorCategories {
    // What a relay alert arrives as. No buttons: without a decrypted option
    // list there is nothing to answer with. A tap still opens Supervisor.
    static func base() -> UNNotificationCategory {
        UNNotificationCategory(identifier: SupervisorPushContent.baseCategory, actions: [], intentIdentifiers: [])
    }

    // One button per option, then Dismiss. Both need an unlocked phone: a tap
    // relays text to a live coding agent (Android does the same).
    static func category(for alert: SupervisorPushContent.Alert) -> UNNotificationCategory {
        var actions = alert.actionTitles.enumerated().map { index, title in
            UNNotificationAction(identifier: SupervisorPushContent.answerActionPrefix + String(index),
                                 title: title, options: [.authenticationRequired])
        }
        actions.append(UNNotificationAction(identifier: SupervisorPushContent.dismissAction,
                                            title: SupervisorPushContent.dismissTitle, options: [.authenticationRequired]))
        return UNNotificationCategory(identifier: alert.categoryIdentifier, actions: actions, intentIdentifiers: [])
    }

    // Everything that is not a per-question `sq.*` category is kept as is.
    // An `sq.*` category survives only while an alert in the shade still
    // uses it, so the set cannot grow without bound.
    static func merged(existing: Set<UNNotificationCategory>, adding: UNNotificationCategory,
                       inUse: Set<String>) -> Set<UNNotificationCategory> {
        var result = existing.filter { category in
            guard category.identifier != adding.identifier else { return false }
            guard category.identifier.hasPrefix(SupervisorPushContent.categoryPrefix) else { return true }
            return inUse.contains(category.identifier)
        }
        result.insert(adding)
        return result
    }

    // Completion-handler APIs rather than async ones, so no non-Sendable
    // UserNotifications object ever crosses an isolation boundary (Swift 6.1
    // strict concurrency rejects that). `completion` runs once the write has
    // landed.
    static func register(_ category: UNNotificationCategory, center: UNUserNotificationCenter = .current(),
                         completion: @escaping @Sendable () -> Void = {}) {
        let box = UncheckedSendableBox(value: (category: category, center: center))
        center.getNotificationCategories { existing in
            let existingBox = UncheckedSendableBox(value: existing)
            box.value.center.getDeliveredNotifications { delivered in
                let inUse = Set(delivered.map(\.request.content.categoryIdentifier))
                box.value.center.setNotificationCategories(
                    merged(existing: existingBox.value, adding: box.value.category, inUse: inUse))
                // Reading the set back waits for the write to land. Without
                // it, an extension that hands its content over straight away
                // can have the alert shown before its category exists, with
                // no buttons.
                box.value.center.getNotificationCategories { _ in completion() }
            }
        }
    }
}

// Carries a value that is not Sendable across a closure or task boundary
// where the code guarantees it is never used from two places at once. Used
// instead of `nonisolated(unsafe)` captures, which Swift 6.1 rejects.
struct UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value
}
