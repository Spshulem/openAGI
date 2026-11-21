import Foundation
import UserNotifications

// What an Approve or Deny tapped on an approval alert came to.
enum ApprovalSendOutcome: Equatable {
    case approved
    case denied
    // Already decided, expired or gone (on the Mac, another phone, a spoken
    // "yes NN"): nothing was sent.
    case notPending
    // The tool ran and failed, or the daemon refused; the text says why.
    case failed(String)
    // An approve may have reached the daemon before it was cut off.
    case unknown

    static func of(error: Error) -> ApprovalSendOutcome {
        switch error as? DaemonError {
        case .notFound?, .conflict?: return .notPending
        case let .transport(underlying)? where mayHaveArrived(underlying): return .unknown
        default: return error is CancellationError ? .unknown : .failed("Couldn't reach OpenAGI.")
        }
    }

    private static func mayHaveArrived(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        guard let code = (error as? URLError)?.code else { return false }
        return [.cancelled, .timedOut, .networkConnectionLost].contains(code)
    }

    var title: String {
        switch self {
        case .approved: return "Approved"
        case .denied: return "Denied"
        case .notPending: return "Already decided"
        case .failed: return "Not done"
        case .unknown: return "May not have gone through"
        }
    }

    var body: String {
        switch self {
        case .approved, .denied: return ""
        case .notPending: return "This approval is no longer waiting. Open Inbox to see it."
        case let .failed(why): return why + " Open Inbox to see it."
        case .unknown: return "Open Inbox to check before trying again."
        }
    }
}

// Approve or Deny from an approval alert, through exactly the calls the
// Inbox makes (POST /pending-actions/:id/approve or /deny, this phone's own
// credential). The system has already asked for Face ID / the passcode
// (the actions are .authenticationRequired). First the action is looked up
// again: one that stopped waiting since the alert arrived is never sent.
// The alert is replaced in place by the result.
@MainActor
enum ApprovalActionSender {
    static func send(_ action: ApprovalAction, notificationID: String) async {
        let center = UNUserNotificationCenter.current()
        guard let credentials = Credentials.load() else {
            center.removeDeliveredNotifications(withIdentifiers: [notificationID])
            return
        }
        let client = DaemonClient(server: credentials.server, nodeID: credentials.nodeID, token: credentials.token)
        let work = Task { await decide(action, client: client) }
        let backgroundTask = BackgroundTaskGuard(name: "approval-action")
        backgroundTask.begin { work.cancel() }
        let outcome = await work.value
        await postResult(outcome, actionID: action.actionId, replacing: notificationID)
        backgroundTask.end()
    }

    // The whole request sequence, apart from notifications, so it is tested
    // against a stubbed daemon.
    nonisolated static func decide(_ action: ApprovalAction, client: DaemonClient) async -> ApprovalSendOutcome {
        guard let id = action.actionId else { return .notPending }
        do {
            let pending = try await client.pendingActions(status: "pending")
            guard pending.contains(where: { $0.id == id }) else { return .notPending }
            switch action {
            case .approve:
                let outcome = try await client.approvePendingAction(id: id)
                if outcome.ok { return .approved }
                let why = outcome.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return .failed(why.isEmpty ? "The action failed." : SupervisorPushContent.cap(why, 160))
            case .deny:
                _ = try await client.denyPendingAction(id: id, reason: nil)
                return .denied
            case .open:
                return .notPending
            }
        } catch {
            return .of(error: error)
        }
    }

    // Same identifier as the alert, so its buttons go away with it. A tap
    // opens Inbox (ApprovalAction.open).
    private static func postResult(_ outcome: ApprovalSendOutcome, actionID: String?, replacing notificationID: String) async {
        let content = UNMutableNotificationContent()
        content.title = outcome.title
        content.body = outcome.body
        content.threadIdentifier = "approvals"
        if let actionID { content.userInfo = [ApprovalPushContent.actionIdKey: actionID] }
        if outcome != .approved && outcome != .denied { content.sound = .default }
        let request = UNNotificationRequest(identifier: notificationID, content: content, trigger: nil)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            UNUserNotificationCenter.current().add(request) { _ in continuation.resume() }
        }
    }
}

extension ApprovalAction {
    var actionId: String? {
        switch self {
        case let .approve(id), let .deny(id): return id
        case .open: return nil
        }
    }
}
