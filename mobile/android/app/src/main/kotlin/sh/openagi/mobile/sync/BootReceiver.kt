package sh.openagi.mobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// A reboot or an app update ends SupervisorAlertService, and both are among
// the few moments Android 12+ still lets an app start a foreground service
// from the background. Without this, alerts would stay off until the owner
// happened to open the app. Exported only because these are system
// broadcasts; the action check keeps anything else from starting the service.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED ->
                SupervisorAlertService.startIfEnabled(context)
        }
    }
}
