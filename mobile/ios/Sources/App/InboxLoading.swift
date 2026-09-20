import Foundation

// DESIGN.md's "Screens must not be mostly empty" section: "Inbox --
// approvals and clarifications are two sections of one list. If one of the
// two fails to load, the other still renders, and the failure is a single
// inline row in that section, not an error that replaces the screen." The
// bug this fixes: `InboxView.load()` used to fetch both lists behind one
// `try await (actions, clars)`, so a single 404 threw before either
// `@State` array was ever assigned -- the whole screen showed nothing but
// that one error string, regardless of what the other endpoint would have
// returned. This type makes the two outcomes independent and testable
// without SwiftUI: each endpoint's `Result` is combined on its own, so one
// `.failure` can never blank out the other's `.success`.
public struct InboxLoadResult: Equatable {
    public var pendingActions: [PendingAction] = []
    public var pendingActionsError: String?
    public var clarifications: [Clarification] = []
    public var clarificationsError: String?

    public init(pendingActions: [PendingAction] = [], pendingActionsError: String? = nil,
                clarifications: [Clarification] = [], clarificationsError: String? = nil) {
        self.pendingActions = pendingActions
        self.pendingActionsError = pendingActionsError
        self.clarifications = clarifications
        self.clarificationsError = clarificationsError
    }
}

public enum InboxLoader {
    public static func combine(pendingActions: Result<[PendingAction], Error>,
                                clarifications: Result<[Clarification], Error>) -> InboxLoadResult {
        var result = InboxLoadResult()
        switch pendingActions {
        case .success(let items): result.pendingActions = items
        case .failure(let error): result.pendingActionsError = message(for: error)
        }
        switch clarifications {
        case .success(let items): result.clarifications = items
        case .failure(let error): result.clarificationsError = message(for: error)
        }
        return result
    }

    // Reuses the exact copy `ApprovalDetailView`/`ClarificationDetailView`
    // already show for the same `DaemonError` cases (InboxDetailViews.swift)
    // -- the same failure should read the same way everywhere it appears.
    public static func message(for error: Error) -> String {
        if let daemonError = error as? DaemonError {
            return ApprovalError.message(for: daemonError)
        }
        return "Can't reach OpenAGI."
    }
}
