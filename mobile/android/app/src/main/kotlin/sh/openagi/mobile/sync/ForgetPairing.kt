package sh.openagi.mobile.sync

import android.content.Context
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient

// Everything "this phone stops being paired" means, in one place. Two paths
// need it — Settings' revoke, and accepting a pairing link for a different
// daemon — and they must not drift: a switch that forgot the outbox would
// replay the old account's queued completions against the new one.
suspend fun forgetPairing(context: Context, credentials: Credentials) {
    // Best-effort: tell the daemon first so it can drop the node immediately,
    // but a phone that cannot reach the daemon must still be able to forget
    // its own credential and stop working locally.
    try {
        DaemonClient(credentials.server, credentials.nodeId, credentials.token).revoke()
    } catch (error: Exception) {
        // Ignored: the local forget below still proceeds.
    }
    Credentials.clear(context)
    RefreshWorker.cancel(context)
    // Through the stores rather than deleting files directly, so each delete
    // holds the lock every writer for that file holds.
    SnapshotStore(context.filesDir).delete()
    OutboundQueue(context.filesDir).clear()
}
