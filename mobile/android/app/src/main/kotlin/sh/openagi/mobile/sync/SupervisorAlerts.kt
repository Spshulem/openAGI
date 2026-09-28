package sh.openagi.mobile.sync

import sh.openagi.mobile.protocol.FleetQuestion

// What one supervisor check should do to the phone's notification shade:
// questions to ping about now, and ids whose notification should go away.
data class AlertPlan(val post: List<FleetQuestion>, val cancel: List<String>)

// The decisions behind a "needs you" notification, kept free of any Android
// type so they can be pinned on the JVM. SupervisorNotifier does the posting.
//
// Question titles and bodies come from agent transcripts. They are shaped here
// for display only: never parsed, never placed in an intent as anything but
// plain notification text, never logged.
object SupervisorAlerts {
    // One check may have a backlog to report: a first run, or a phone that was
    // off for a day. Five pings at once is already a lot; the rest go out on
    // the following checks, since what posted here is remembered as notified.
    const val MAX_POSTS_PER_CHECK = 5

    // Ids below this are the app's own fixed notifications (the live-alerts
    // service's ongoing one is 1001, the answer worker's foreground one 1002).
    // A question's id always lands above them, so a hash can never replace the
    // ongoing notification with a question or cancel it by accident.
    const val FIRST_QUESTION_ID = 10_000

    private const val TITLE_MAX = 100
    private const val TEXT_MAX = 220
    private const val MAX_ACTIONS = 3
    private const val DISMISS = "dismiss"
    private const val FALLBACK_TITLE = "Needs you"

    // Every open question is posted once. "notified" is what stops a second
    // ping for a question the owner already saw or swiped away, and what says
    // which notifications to take down once their question closes anywhere
    // (the Mac, the dashboard, another phone, or the supervisor itself).
    fun plan(open: List<FleetQuestion>, notified: Set<String>): AlertPlan {
        val openIds = open.mapTo(HashSet()) { it.id }
        val post = open
            .filter { it.id.isNotBlank() && it.id !in notified }
            .distinctBy { it.id }
            .take(MAX_POSTS_PER_CHECK)
        val cancel = notified.filter { it !in openIds }
        return AlertPlan(post, cancel)
    }

    // String.hashCode is specified by the language, so the same question gets
    // the same notification id in every process: a later check or the answer
    // worker can replace or cancel what an earlier one posted. Masking the
    // sign bit keeps it non-negative; anything that lands in the reserved
    // range is shifted up past it.
    fun notificationId(questionId: String): Int {
        val hash = questionId.hashCode() and Int.MAX_VALUE
        return if (hash < FIRST_QUESTION_ID) hash + FIRST_QUESTION_ID else hash
    }

    // The daemon accepts only an exact option string (routes.js checks
    // options.includes(answer)), so the text is passed through untouched —
    // trimming " yes " would turn a valid answer into a 400. "dismiss" is not
    // an answer but the separate dismissal, the same filter the Supervisor
    // screen and the dashboard apply. Android shows at most three actions.
    fun actionOptions(q: FleetQuestion): List<String> =
        q.options
            .filter { it.isNotBlank() && !it.trim().equals(DISMISS, ignoreCase = true) }
            .distinct()
            .take(MAX_ACTIONS)

    fun title(q: FleetQuestion): String =
        cap(q.title?.trim().orEmpty().ifEmpty { FALLBACK_TITLE }, TITLE_MAX)

    fun text(q: FleetQuestion): String = cap(q.body?.trim().orEmpty(), TEXT_MAX)

    // The daemon already clamps titles and bodies, but to its own limits; a
    // notification needs shorter ones. The ellipsis counts toward the cap, and
    // the cut steps back off a high surrogate so an emoji is never halved.
    internal fun cap(value: String, max: Int): String {
        if (value.length <= max) return value
        var end = max - 1
        if (Character.isHighSurrogate(value[end - 1])) end--
        return value.substring(0, end).trimEnd() + "…"
    }
}
