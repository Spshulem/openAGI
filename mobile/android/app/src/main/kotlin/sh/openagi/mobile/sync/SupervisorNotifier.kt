package sh.openagi.mobile.sync

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import sh.openagi.mobile.MainActivity
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetState
import sh.openagi.mobile.store.NotifiedQuestionsStore

// The Android half of supervisor alerts: channels, the "needs you"
// notification with one button per answer, and the sending/failed notices
// an answer tap turns it into. What to post and when is SupervisorAlerts'
// call; this only draws it. No push service is involved — the phone learns
// about questions from its own paired daemon (SupervisorAlertCheck).
object SupervisorNotifier {
    const val CHANNEL_QUESTIONS = "supervisor-questions"
    const val CHANNEL_LIVE = "supervisor-live"
    const val EXTRA_TAB = "sh.openagi.mobile.extra.TAB"
    const val TAB_SUPERVISOR = "supervisor"
    const val EXTRA_QUESTION_ID = "sh.openagi.mobile.extra.QUESTION_ID"

    // The app ships no drawables of its own yet; a system one keeps the
    // status bar icon a clean monochrome silhouette as Android requires.
    private val SMALL_ICON = android.R.drawable.ic_dialog_info
    private const val ACTION_LABEL_MAX = 40
    private const val SENDING_ANSWER_MAX = 80

    // Idempotent: creating an existing channel only updates its name and
    // description, never the importance the owner may have changed since.
    fun ensureChannels(context: Context) {
        NotificationManagerCompat.from(context).createNotificationChannelsCompat(
            listOf(
                NotificationChannelCompat.Builder(CHANNEL_QUESTIONS, NotificationManagerCompat.IMPORTANCE_HIGH)
                    .setName("Supervisor questions")
                    .setDescription("An agent is waiting on your answer.")
                    .build(),
                NotificationChannelCompat.Builder(CHANNEL_LIVE, NotificationManagerCompat.IMPORTANCE_MIN)
                    .setName("Supervisor connection")
                    .setDescription("Shown while live supervisor alerts are on.")
                    .setShowBadge(false)
                    .build(),
            ),
        )
    }

    // Brings the shade in line with the daemon's open questions. Closing is
    // always applied, so a question answered on the Mac disappears here too.
    // Posting is skipped while notifications are off, and a skipped question
    // is deliberately not remembered: it posts on the first check after the
    // owner turns them back on, instead of being silently marked as seen.
    fun sync(context: Context, state: FleetState, store: NotifiedQuestionsStore) {
        val manager = NotificationManagerCompat.from(context)
        val plan = SupervisorAlerts.plan(state.questions, store.load())
        plan.cancel.forEach { id ->
            manager.cancel(SupervisorAlerts.notificationId(id))
            store.remove(id)
        }
        if (plan.post.isEmpty()) return
        ensureChannels(context)
        if (!canPostQuestions(context)) return
        plan.post.forEach { question ->
            if (post(context, SupervisorAlerts.notificationId(question.id), questionNotification(context, question))) {
                store.add(question.id)
            }
        }
    }

    // Replaces the question's notification in place (same id) the moment a
    // button is tapped, so the buttons go away before a second tap can queue
    // a second answer. Silent: the owner is looking at it.
    fun showSending(context: Context, questionId: String, answer: String) {
        ensureChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_QUESTIONS)
            .setSmallIcon(SMALL_ICON)
            .setContentTitle("Sending your answer…")
            .setContentText(SupervisorAlerts.cap(answer.trim(), SENDING_ANSWER_MAX))
            .setProgress(0, 0, true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setSilent(true)
            .setContentIntent(openSupervisorIntent(context, questionId))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        post(context, SupervisorAlerts.notificationId(questionId), notification)
    }

    // Not silent: this can land minutes after the tap, once retries run out,
    // and the question is still waiting on the owner. The id stays in the
    // store, so the next check does not re-post the original over this; the
    // notice goes away with the question, or on tap into Supervisor.
    fun showFailed(context: Context, questionId: String, title: String) {
        ensureChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_QUESTIONS)
            .setSmallIcon(SMALL_ICON)
            .setContentTitle(SupervisorAlerts.cap(title.trim(), 100))
            .setContentText("Open Supervisor to answer it there.")
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setAutoCancel(true)
            .setContentIntent(openSupervisorIntent(context, questionId))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        post(context, SupervisorAlerts.notificationId(questionId), notification)
    }

    fun cancel(context: Context, questionId: String) {
        NotificationManagerCompat.from(context).cancel(SupervisorAlerts.notificationId(questionId))
    }

    // Everything this pairing ever posted, and every answer still queued for
    // it: a queued answer left behind would be sent to whichever daemon the
    // phone pairs with next. The channel sweep catches notices the store no
    // longer lists (a corrupt file, a question already removed after its
    // answer). The ongoing live-alerts notification is on CHANNEL_LIVE and is
    // the service's to remove.
    fun cancelAll(context: Context, store: NotifiedQuestionsStore) {
        SupervisorAnswerWorker.cancelAll(context)
        val manager = NotificationManagerCompat.from(context)
        store.load().forEach { manager.cancel(SupervisorAlerts.notificationId(it)) }
        runCatching {
            manager.activeNotifications
                .filter { it.notification.channelId == CHANNEL_QUESTIONS }
                .forEach { manager.cancel(it.tag, it.id) }
        }
        store.clear()
    }

    // Opens the app on the Supervisor tab. MainActivity is singleTask, so a
    // running app receives this in onNewIntent. Public so the live-alerts
    // service's ongoing notification can open the same place.
    fun openSupervisorIntent(context: Context, questionId: String? = null): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(EXTRA_TAB, TAB_SUPERVISOR)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (questionId != null) {
            intent.putExtra(EXTRA_QUESTION_ID, questionId)
            // See answerIntent: extras never tell two PendingIntents apart.
            intent.identifier = "open/$questionId"
        }
        val requestCode = questionId?.let { SupervisorAlerts.notificationId(it) } ?: 0
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // For the answer worker's getForegroundInfo, which WorkManager only calls
    // below Android 12 — never on this app's minSdk, but required by contract.
    internal fun answerWorkNotification(context: Context): Notification {
        ensureChannels(context)
        return NotificationCompat.Builder(context, CHANNEL_LIVE)
            .setSmallIcon(SMALL_ICON)
            .setContentTitle("Sending your answer")
            .setSilent(true)
            .setOngoing(true)
            .build()
    }

    private fun questionNotification(context: Context, question: FleetQuestion): Notification {
        val title = SupervisorAlerts.title(question)
        val text = SupervisorAlerts.text(question)
        val builder = NotificationCompat.Builder(context, CHANNEL_QUESTIONS)
            .setSmallIcon(SMALL_ICON)
            .setContentTitle(title)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(openSupervisorIntent(context, question.id))
            // Titles and bodies quote agent transcripts. On a lock screen set
            // to hide sensitive content, show that something is waiting and
            // nothing of what.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CHANNEL_QUESTIONS)
                    .setSmallIcon(SMALL_ICON)
                    .setContentTitle("An agent needs you")
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .build(),
            )
        if (text.isNotEmpty()) {
            builder.setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text).setBigContentTitle(title))
        }
        question.createdAt?.let { builder.setWhen(it.toEpochMilli()).setShowWhen(true) }
        SupervisorAlerts.actionOptions(question).forEachIndexed { index, option ->
            val label = SupervisorAlerts.cap(option.trim(), ACTION_LABEL_MAX)
            builder.addAction(0, label, answerIntent(context, question.id, option, index))
        }
        return builder.build()
    }

    private fun answerIntent(context: Context, questionId: String, answer: String, index: Int): PendingIntent {
        val intent = Intent(context, SupervisorAnswerReceiver::class.java)
            .setAction(SupervisorAnswerReceiver.ACTION_ANSWER)
            .putExtra(EXTRA_QUESTION_ID, questionId)
            .putExtra(SupervisorAnswerReceiver.EXTRA_ANSWER, answer)
        // PendingIntents are told apart by requestCode and Intent.filterEquals,
        // never by extras. Two buttons equal on both would share one
        // PendingIntent, and FLAG_UPDATE_CURRENT would quietly point the older
        // button at the newer question's answer. The identifier is part of
        // filterEquals, so each question+option is its own PendingIntent even
        // if two hashed request codes ever collide.
        intent.identifier = "answer/$questionId/$index"
        val requestCode = "$questionId\u0000$index".hashCode()
        return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // Android 13's runtime grant, the app-wide switch in system settings, and
    // the questions channel itself: a blocked channel swallows notify()
    // without an error, which would otherwise mark questions as seen that
    // never showed.
    private fun canPostQuestions(context: Context): Boolean {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return manager.getNotificationChannelCompat(CHANNEL_QUESTIONS)?.importance != NotificationManagerCompat.IMPORTANCE_NONE
    }

    // Permission is checked by callers that decide whether to remember a
    // post (sync); it can still be revoked between that check and this call.
    @SuppressLint("MissingPermission")
    private fun post(context: Context, id: Int, notification: Notification): Boolean = try {
        NotificationManagerCompat.from(context).notify(id, notification)
        true
    } catch (denied: SecurityException) {
        false
    }
}
