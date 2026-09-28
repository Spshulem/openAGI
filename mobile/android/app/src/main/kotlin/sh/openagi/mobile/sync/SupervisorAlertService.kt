package sh.openagi.mobile.sync

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.openagi.mobile.store.AlertPrefs
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.EventStream

// Frames on GET /events after which the supervisor's open questions may have
// changed. `fleet` is every supervisor tick; `outreach`/`outreach-resolved` is
// how a question asked or closed on the Mac reaches a Distiller main that
// mirrors it (src/fleet/remote.js); `hello` opens every (re)connect, so
// anything asked while the stream was down is caught up on straight away.
internal val ALERT_TRIGGERING_EVENTS = setOf("hello", "fleet", "outreach", "outreach-resolved")

// Turns a burst of "check now" requests into one check. The first request
// opens a window; everything else that arrives inside it is folded into the
// check that runs when it closes. A request that lands while a check is
// already fetching is kept, not dropped, and runs one more check after it:
// that fetch may have read the state from just before the question appeared.
// Pure coroutines, no Android, so SupervisorAlertServiceTest drives it on
// virtual time.
internal class CheckCoalescer(
    private val windowMillis: Long,
    private val check: suspend () -> Unit,
) {
    private val requests = Channel<Unit>(Channel.CONFLATED)

    fun request() {
        requests.trySend(Unit)
    }

    // Runs until the calling coroutine is cancelled.
    suspend fun run() {
        for (ignored in requests) {
            delay(windowMillis)
            requests.tryReceive()
            check()
        }
    }
}

// Without a push service (README: nothing OpenAGI-operated sits between the
// phone and the daemon) the only way to hear about a question within seconds
// is to hold GET /events open, and Android only lets that outlive the app's
// UI inside a foreground service. The quiet CHANNEL_LIVE notification is the
// price, which is why Settings makes this a switch. When the service is not
// running (switched off, refused a background start, or killed),
// RefreshWorker's 15-minute check is the fallback.
class SupervisorAlertService : Service() {
    // IO, not Default: each check reads the fleet state and rewrites the
    // notified-ids file.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var watchJob: Job? = null
    private var watching: Credentials? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        SupervisorNotifier.ensureChannels(this)
        // Before anything that can return early: a service started with
        // startForegroundService that does not call startForeground within a
        // few seconds takes the whole app down.
        if (!enterForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }
        val credentials = Credentials.load(this)
        if (credentials == null || !AlertPrefs.liveAlertsEnabled(this)) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        // A second start (Settings, a boot racing an app open) can land on a
        // service that is already watching. Keep that stream; replace it only
        // when the phone has been paired to a different daemon since.
        if (watchJob?.isActive != true || watching != credentials) {
            watchJob?.cancel()
            watching = credentials
            watchJob = scope.launch { watchFleet(credentials) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun watchFleet(credentials: Credentials) = coroutineScope {
        val client = DaemonClient(credentials.server, credentials.nodeId, credentials.token)
        val coalescer = CheckCoalescer(DEBOUNCE_MILLIS) { checkSupervisorAlerts(applicationContext, client) }
        launch { coalescer.run() }
        // One check on start, then a slow poll: a stream that looks attached
        // but has silently stopped delivering must not hide a question for
        // longer than this.
        launch {
            while (true) {
                coalescer.request()
                delay(FALLBACK_MILLIS)
            }
        }
        // EventStream never completes and reconnects with backoff on its own,
        // a refused token included; forgetPairing stops this service.
        EventStream(client).connect().collect { frame ->
            if (frame.event in ALERT_TRIGGERING_EVENTS) coalescer.request()
        }
    }

    private fun enterForeground(): Boolean = try {
        val notification = ongoingNotification()
        // The typed overload is required from Android 14, where every
        // foreground service must name its type; below that the manifest's
        // type applies on its own.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(ONGOING_ID, notification)
        }
        true
    } catch (notAllowed: ForegroundServiceStartNotAllowedException) {
        // A START_STICKY restart the system made while the app is in the
        // background. The worker covers until the app is next opened.
        false
    }

    private fun ongoingNotification(): Notification =
        NotificationCompat.Builder(this, SupervisorNotifier.CHANNEL_LIVE)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Watching your agents")
            .setContentText("You'll get a notification when one needs you.")
            .setContentIntent(SupervisorNotifier.openSupervisorIntent(this))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build()

    companion object {
        const val ONGOING_ID = 1001
        private const val DEBOUNCE_MILLIS = 3_000L
        private const val FALLBACK_MILLIS = 5 * 60_000L

        // onCreate to onDestroy, in the same process as every caller. Lets
        // the start that runs on every app resume skip a service that is
        // already watching, instead of re-entering onStartCommand each time.
        @Volatile private var running = false

        // Called from Settings and BootReceiver. Also the off switch for every
        // reason to not run: unpaired, switched off, or notifications blocked,
        // where holding a connection open could only feed alerts nobody sees.
        fun startIfEnabled(context: Context) {
            startIfEnabled(context, paired = Credentials.load(context.applicationContext) != null)
        }

        // For MainActivity (launch, resume, pairing, the permission prompt),
        // which already holds the credential: spares a Keystore read on every
        // resume.
        fun startIfEnabled(context: Context, paired: Boolean) {
            val app = context.applicationContext
            if (!paired || !AlertPrefs.liveAlertsEnabled(app) || !notificationsPermitted(app)) {
                stop(app)
                return
            }
            if (running) return
            try {
                ContextCompat.startForegroundService(app, Intent(app, SupervisorAlertService::class.java))
            } catch (notAllowed: ForegroundServiceStartNotAllowedException) {
                // Android 12+ refuses a background start outside a few
                // exempt moments (boot, an app update, a visible Activity).
                // RefreshWorker's check still runs; the next app open retries.
            }
        }

        fun stop(context: Context) {
            // Cleared here too, not only in onDestroy, so a start that follows
            // straight after (switching daemons) is not skipped as a duplicate.
            running = false
            context.applicationContext.stopService(Intent(context.applicationContext, SupervisorAlertService::class.java))
        }

        // POST_NOTIFICATIONS is Android 13's runtime grant; the app-wide
        // switch in system settings and the questions channel can each be
        // off with it still granted. A channel not created yet is not off.
        fun notificationsPermitted(context: Context): Boolean {
            val manager = NotificationManagerCompat.from(context)
            val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            return granted && manager.areNotificationsEnabled() &&
                manager.getNotificationChannelCompat(SupervisorNotifier.CHANNEL_QUESTIONS)?.importance != NotificationManagerCompat.IMPORTANCE_NONE
        }
    }
}
