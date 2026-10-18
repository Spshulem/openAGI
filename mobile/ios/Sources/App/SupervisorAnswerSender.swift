import Foundation
import UIKit
import UserNotifications

// What sending one tapped answer came to. Mirrors Android's answerOutcome,
// minus the retries: iOS gives a background action one short window.
enum SupervisorAnswerOutcome: Equatable {
    // Sent, or nothing left to send: 404 and 409 both mean the question is
    // already closed (answered on the Mac or another phone, or resolved).
    case done
    // A 200 whose delivery to the agent was blocked or failed; the daemon
    // keeps the question open.
    case undelivered(String)
    case failed
    // The request may have reached the daemon before it was cut off (time ran
    // out, the connection dropped): the agent may still get the answer, so
    // the owner is told to check rather than to send it again.
    case unknown

    // Queued answers are durable and the daemon has closed the question.
    private static let delivered: Set<String> = ["sent", "dry-run", "done", "queued"]

    static func of(error: Error?, delivery: FleetDelivery?) -> SupervisorAnswerOutcome {
        if let error {
            switch error as? DaemonError {
            case .notFound?, .conflict?: return .done
            case let .transport(underlying)? where mayHaveArrived(underlying): return .unknown
            default: return error is CancellationError ? .unknown : .failed
            }
        }
        guard let status = delivery?.status, !delivered.contains(status) else { return .done }
        let detail = delivery?.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .undelivered(detail.isEmpty ? "The agent could not be reached" : detail)
    }

    private static func mayHaveArrived(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        guard let code = (error as? URLError)?.code else { return false }
        return [.cancelled, .timedOut, .networkConnectionLost].contains(code)
    }
}

// Sends an answer or dismissal tapped on a supervisor alert, straight to the
// paired daemon (POST /fleet/api/questions/:id). The alert goes away when the
// question is done; otherwise it is replaced in place by a "Not sent" notice
// whose tap opens Supervisor, like Android's.
@MainActor
enum SupervisorAnswerSender {
    static let notSentBody = "Open Supervisor to answer it there."

    static func send(_ action: SupervisorAnswerAction, notificationID: String) async {
        let center = UNUserNotificationCenter.current()
        guard let credentials = Credentials.load() else {
            // Unpaired since the alert arrived: nothing to send it to.
            center.removeDeliveredNotifications(withIdentifiers: [notificationID])
            return
        }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        let questionID: String
        switch action {
        case let .answer(id, _), let .dismiss(id): questionID = id
        case .open: return
        }

        // A background action gets roughly 30 seconds; relaying an answer can
        // take longer. When time runs out the request is cancelled, but the
        // daemon may still deliver it, so the owner is told to check.
        let work = Task { () -> SupervisorAnswerOutcome in
            do {
                switch action {
                case let .answer(id, answer):
                    let result = try await client.fleetAnswer(questionID: id, answer: answer)
                    return .of(error: nil, delivery: result.delivery)
                case let .dismiss(id):
                    _ = try await client.fleetDismiss(questionID: id)
                    return .done
                case .open:
                    return .done
                }
            } catch {
                return .of(error: error, delivery: nil)
            }
        }
        let backgroundTask = BackgroundTaskGuard()
        backgroundTask.begin { work.cancel() }
        let outcome = await work.value

        switch outcome {
        case .done:
            center.removeDeliveredNotifications(withIdentifiers: [notificationID])
        case let .undelivered(why):
            await postNotSent(title: "Not sent: \(why)", questionID: questionID, replacing: notificationID)
        case .failed:
            await postNotSent(title: "Not sent", questionID: questionID, replacing: notificationID,
                              body: "Couldn't send your answer. " + notSentBody)
        case .unknown:
            await postNotSent(title: "May not have sent", questionID: questionID, replacing: notificationID,
                              body: "Your answer may still reach the agent. Open Supervisor to check before answering again.")
        }
        backgroundTask.end()
    }

    // Same identifier as the alert, so it replaces it (and its buttons)
    // instead of stacking a second notification for one question.
    private static func postNotSent(title: String, questionID: String, replacing notificationID: String,
                                    body: String = notSentBody) async {
        let content = UNMutableNotificationContent()
        content.title = SupervisorPushContent.cap(title, 100)
        content.body = body
        content.sound = .default
        content.threadIdentifier = "supervisor"
        content.categoryIdentifier = SupervisorPushContent.baseCategory
        content.userInfo = [SupervisorPushContent.questionIdKey: questionID]
        let request = UNNotificationRequest(identifier: notificationID, content: content, trigger: nil)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            UNUserNotificationCenter.current().add(request) { _ in continuation.resume() }
        }
    }

    // The daemon cannot take back an alert it already pushed when the
    // question closes elsewhere; the app clears those whenever it opens.
    static func clearClosedAlerts(client: DaemonClient) async {
        guard let state = try? await client.fleetState() else { return }
        let center = UNUserNotificationCenter.current()
        // Only Sendable strings leave the callback.
        let delivered = await withCheckedContinuation { (continuation: CheckedContinuation<[(id: String, questionID: String?)], Never>) in
            center.getDeliveredNotifications { notifications in
                continuation.resume(returning: notifications.map { notification in
                    (id: notification.request.identifier,
                     questionID: notification.request.content.userInfo[SupervisorPushContent.questionIdKey] as? String)
                })
            }
        }
        let stale = staleNotificationIDs(delivered: delivered, open: Set(state.questions.map(\.id)))
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }

    // Only notifications that carry a question id are ours to judge.
    nonisolated static func staleNotificationIDs(delivered: [(id: String, questionID: String?)], open: Set<String>) -> [String] {
        delivered.compactMap { entry in
            guard let questionID = entry.questionID, !open.contains(questionID) else { return nil }
            return entry.id
        }
    }
}

// One background assertion, ended exactly once: by the normal path or by
// the expiration handler, whichever comes first. Leaving an expired
// assertion un-ended gets the app killed. `beginTask` / `endTask` are
// injectable so the once-only rule is testable without UIApplication.
@MainActor
final class BackgroundTaskGuard {
    typealias Begin = (_ expiration: @escaping @MainActor () -> Void) -> UIBackgroundTaskIdentifier

    private let beginTask: Begin
    private let endTask: (UIBackgroundTaskIdentifier) -> Void
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init(name: String = "supervisor-answer",
         beginTask: Begin? = nil,
         endTask: ((UIBackgroundTaskIdentifier) -> Void)? = nil) {
        self.beginTask = beginTask ?? { expiration in
            UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expiration)
        }
        self.endTask = endTask ?? { UIApplication.shared.endBackgroundTask($0) }
    }

    func begin(onExpire: @escaping @MainActor () -> Void) {
        identifier = beginTask { [weak self] in
            onExpire()
            self?.end()
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        let ending = identifier
        identifier = .invalid
        endTask(ending)
    }
}
