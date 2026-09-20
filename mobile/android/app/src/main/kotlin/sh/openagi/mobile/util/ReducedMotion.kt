package sh.openagi.mobile.util

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

// DESIGN.md: "Respect reduced-motion: the row still disappears, it just does
// not animate." The system exposes this as an animator duration scale of 0,
// the same signal Android's own animation framework checks.
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        try {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        } catch (error: Exception) {
            false
        }
    }
}
