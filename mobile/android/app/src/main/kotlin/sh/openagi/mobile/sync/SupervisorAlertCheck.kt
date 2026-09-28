package sh.openagi.mobile.sync

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.NotifiedQuestionsStore
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException

// Process-wide, not per caller: the live-alerts service and RefreshWorker can
// both decide to check in the same second, and two overlapping syncs would
// each read the notified set before the other wrote it and post every new
// question twice.
private val checkLock = Mutex()

// What one check found, so the live-alerts service can stop watching a daemon
// that will never have questions for this phone.
enum class AlertCheckResult { Checked, Offline, NoSupervisor, Unauthorized }

// Every other change to the notified set (an answer landing, Forget pairing)
// runs under the same lock, so a check already in flight cannot re-post a
// question that was just answered or re-post the old daemon's questions.
suspend fun <T> withAlertLock(block: suspend () -> T): T = checkLock.withLock { block() }

// One look at the paired daemon's open supervisor questions, reconciled with
// the notification shade. Returns whether a check actually happened.
//
// Any failure changes nothing. A phone that cannot reach its daemon, a daemon
// without a supervisor (Unavailable) or a refused credential (Unauthorized)
// says nothing about which questions closed, so taking notifications down
// then would wrongly clear pings the owner has not acted on yet.
suspend fun checkSupervisorAlerts(context: Context, client: DaemonClient): AlertCheckResult = checkLock.withLock {
    val app = context.applicationContext
    val state = try {
        client.fleetState()
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (error: DaemonException.Unavailable) {
        return@withLock AlertCheckResult.NoSupervisor
    } catch (error: DaemonException.Unauthorized) {
        return@withLock AlertCheckResult.Unauthorized
    } catch (error: Exception) {
        return@withLock AlertCheckResult.Offline
    }
    // The fetch can take seconds. A pairing forgotten meanwhile has already
    // cleared its notifications; posting this old daemon's questions now
    // would bring them back under nobody's credential.
    if (Credentials.load(app) == null) return@withLock AlertCheckResult.Unauthorized
    try {
        SupervisorNotifier.sync(app, state, NotifiedQuestionsStore(app.filesDir))
        AlertCheckResult.Checked
    } catch (error: Exception) {
        // A notification-manager hiccup is not worth crashing the service or
        // failing the refresh worker over; the next check reconciles again.
        AlertCheckResult.Offline
    }
}
