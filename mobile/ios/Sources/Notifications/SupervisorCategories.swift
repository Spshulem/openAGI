import Foundation
import UserNotifications
import Darwin

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
                         coordinationDirectory: URL = SharedContainer.url.appending(path: "push-categories"),
                         completion: @escaping @Sendable () -> Void = {}) {
        let box = UncheckedSendableBox(value: (category: category, center: center))
        // The app and extension can write from different processes. Acquire
        // the shared file lock on a worker, never on the caller's UI thread.
        DispatchQueue.global(qos: .userInitiated).async {
            guard let lease = CategoryRegistrationLease(directory: coordinationDirectory,
                                                         adding: box.value.category.identifier) else {
                completion()
                return
            }
            box.value.center.getNotificationCategories { existing in
                let existingBox = UncheckedSendableBox(value: existing)
                box.value.center.getDeliveredNotifications { delivered in
                    // A preceding extension can have finished registration
                    // just before its alert appears in the delivered list.
                    let inUse = Set(delivered.map(\.request.content.categoryIdentifier)).union(lease.recent)
                    box.value.center.setNotificationCategories(
                        merged(existing: existingBox.value, adding: box.value.category, inUse: inUse))
                    // Keep the lock until the write has landed and the
                    // extension hands its rewritten alert back to the system.
                    box.value.center.getNotificationCategories { _ in
                        withExtendedLifetime(lease) { completion() }
                    }
                }
            }
        }
    }
}

// A tiny shared registration journal covers the gap before delivery. Old
// entries expire after a minute; delivered notifications retain their own
// categories through the normal merge. The OS releases the lock on exit.
private final class CategoryRegistrationLease: @unchecked Sendable {
    let recent: Set<String>
    private let descriptor: Int32

    init?(directory: URL, adding: String) {
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        catch { return nil }
        let fd = Darwin.open(directory.appending(path: "registration.lock").path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX) == 0 else { Darwin.close(fd); return nil }
        let journal = directory.appending(path: "recent.json")
        let now = Date().timeIntervalSince1970
        var entries = (try? Data(contentsOf: journal)).flatMap { try? JSONDecoder().decode([String: Double].self, from: $0) } ?? [:]
        entries = entries.filter { $0.value > now - 60 }
        if adding.hasPrefix(SupervisorPushContent.categoryPrefix) { entries[adding] = now }
        do { try JSONEncoder().encode(entries).write(to: journal, options: .atomic) }
        catch { flock(fd, LOCK_UN); Darwin.close(fd); return nil }
        descriptor = fd
        recent = Set(entries.keys)
    }

    deinit {
        flock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
    }
}

// Carries a value that is not Sendable across a closure or task boundary
// where the code guarantees it is never used from two places at once. Used
// instead of `nonisolated(unsafe)` captures, which Swift 6.1 rejects.
struct UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value
}
