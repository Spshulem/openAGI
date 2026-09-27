package sh.openagi.mobile.ui

import sh.openagi.mobile.protocol.Clarification
import sh.openagi.mobile.protocol.PendingAction
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.util.ErrorCopy

// DESIGN.md's "Screens must not be mostly empty": "Inbox — approvals and
// clarifications are two sections of one list. If one of the two fails to
// load, the other still renders, and the failure is a single inline row in
// that section, not an error that replaces the screen." The daemon bug this
// was written against (`GET /tasks/:id` swallowing `/tasks/clarifications`,
// fixed at HEAD) is gone, but the client's own defect survives it: a single
// `try { a(); b() } catch` around both calls means a failure on the first
// request stops the second from ever being attempted. Each section here is
// fetched and caught independently, exactly the way fetchInboxBadgeCount
// already does — a failure on one side can never suppress the other.
data class InboxSectionState<T>(val items: List<T>?, val error: ErrorCopy.Message?)

data class InboxLoadResult(
    val actions: InboxSectionState<PendingAction>,
    val clarifications: InboxSectionState<Clarification>,
)

private fun <T> sectionFrom(result: Result<List<T>>, host: String): InboxSectionState<T> = result.fold(
    onSuccess = { InboxSectionState(items = it, error = null) },
    onFailure = { throwable ->
        val daemonError = throwable as? DaemonException
        val message = if (daemonError != null) {
            ErrorCopy.forDaemon(daemonError, host)
        } else {
            ErrorCopy.Message("Can't load this.", "Try again in a moment.")
        }
        InboxSectionState(items = null, error = message)
    },
)

suspend fun loadInbox(client: DaemonClient, host: String): InboxLoadResult {
    val actionsResult = runCatching { client.pendingActions() }
    val clarificationsResult = runCatching { client.clarifications() }
    return InboxLoadResult(
        actions = sectionFrom(actionsResult, host),
        clarifications = sectionFrom(clarificationsResult, host),
    )
}
