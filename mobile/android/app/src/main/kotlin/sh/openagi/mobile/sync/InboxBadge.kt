package sh.openagi.mobile.sync

import sh.openagi.mobile.transport.DaemonClient

// FEATURES.md: "The Inbox tab carries a badge with the count of items
// waiting. That count is the one number worth interrupting someone for."
// Both halves are fetched independently and a failure on either side counts
// as zero for that half rather than failing the whole badge — a phone that
// can reach pending-actions but is momentarily slow on clarifications (or
// vice versa) should still show a partial, honest count instead of none.
suspend fun fetchInboxBadgeCount(client: DaemonClient): Int {
    val pendingActions = runCatching { client.pendingActions(status = "pending").size }.getOrDefault(0)
    val clarifications = runCatching { client.clarifications(status = "pending").size }.getOrDefault(0)
    return pendingActions + clarifications
}
