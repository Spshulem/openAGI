package sh.openagi.mobile.store

import android.content.Context
import android.content.SharedPreferences

// Two plain preferences, nothing secret: whether the owner wants the live
// alerts service running, and whether this phone has already asked for
// notification permission. Plain SharedPreferences rather than Credentials'
// encrypted store — neither value is sensitive, and neither should depend on
// the Keystore being healthy.
object AlertPrefs {
    private const val FILE = "openagi-alerts"
    private const val KEY_LIVE_ALERTS = "liveAlertsEnabled"
    private const val KEY_PERMISSION_ASKED = "notificationPermissionAsked"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    // On unless the owner turned it off: a phone paired to a supervisor is
    // there to be told when an agent needs it.
    fun liveAlertsEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_LIVE_ALERTS, true)

    fun setLiveAlertsEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_LIVE_ALERTS, enabled).apply()
    }

    // Android shows the POST_NOTIFICATIONS prompt only a couple of times before
    // treating a repeat request as a silent denial, so the app asks once on
    // its own and leaves any later change to system settings.
    fun notificationPermissionAsked(context: Context): Boolean = prefs(context).getBoolean(KEY_PERMISSION_ASKED, false)

    fun setNotificationPermissionAsked(context: Context, asked: Boolean = true) {
        prefs(context).edit().putBoolean(KEY_PERMISSION_ASKED, asked).apply()
    }
}
