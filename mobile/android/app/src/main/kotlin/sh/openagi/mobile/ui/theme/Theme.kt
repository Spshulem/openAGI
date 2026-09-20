package sh.openagi.mobile.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

// The two colours that must never drift: a task being overdue must not change
// hue with the wallpaper, so `live`/`alert` are read from this local, never
// from MaterialTheme.colorScheme.primary/error even where those happen to
// carry the same value today.
data class OpenAGIExtraColors(val live: androidx.compose.ui.graphics.Color, val alert: androidx.compose.ui.graphics.Color, val edge: androidx.compose.ui.graphics.Color)

val LocalOpenAGIColors = staticCompositionLocalOf {
    OpenAGIExtraColors(OpenAGIColors.liveLight, OpenAGIColors.alertLight, OpenAGIColors.edgeLight)
}

private fun lightScheme(dynamic: androidx.compose.material3.ColorScheme?) = lightColorScheme(
    primary = OpenAGIColors.liveLight,
    onPrimary = OpenAGIColors.white,
    // Container tints are the one place Material You dynamic colour is
    // welcome per DESIGN.md; fall back to a quiet tint of `live` when dynamic
    // colour isn't available (pre-Android 12, which minSdk 31 never hits, but
    // kept as an honest fallback rather than an unreachable branch).
    primaryContainer = dynamic?.primaryContainer ?: OpenAGIColors.liveLight.copy(alpha = 0.12f),
    onPrimaryContainer = dynamic?.onPrimaryContainer ?: OpenAGIColors.inkLight,
    secondaryContainer = dynamic?.secondaryContainer ?: OpenAGIColors.surfaceLight,
    onSecondaryContainer = dynamic?.onSecondaryContainer ?: OpenAGIColors.inkLight,
    tertiaryContainer = dynamic?.tertiaryContainer ?: OpenAGIColors.surfaceLight,
    onTertiaryContainer = dynamic?.onTertiaryContainer ?: OpenAGIColors.inkLight,
    error = OpenAGIColors.alertLight,
    onError = OpenAGIColors.white,
    errorContainer = OpenAGIColors.alertLight.copy(alpha = 0.12f),
    onErrorContainer = OpenAGIColors.alertLight,
    background = OpenAGIColors.canvasLight,
    onBackground = OpenAGIColors.inkLight,
    surface = OpenAGIColors.surfaceLight,
    onSurface = OpenAGIColors.inkLight,
    surfaceVariant = OpenAGIColors.surfaceLight,
    onSurfaceVariant = OpenAGIColors.mutedLight,
    outline = OpenAGIColors.edgeLight,
    outlineVariant = OpenAGIColors.edgeLight,
)

private fun darkScheme(dynamic: androidx.compose.material3.ColorScheme?) = darkColorScheme(
    primary = OpenAGIColors.liveDark,
    onPrimary = OpenAGIColors.inkDark,
    primaryContainer = dynamic?.primaryContainer ?: OpenAGIColors.liveDark.copy(alpha = 0.16f),
    onPrimaryContainer = dynamic?.onPrimaryContainer ?: OpenAGIColors.inkDark,
    secondaryContainer = dynamic?.secondaryContainer ?: OpenAGIColors.surfaceDark,
    onSecondaryContainer = dynamic?.onSecondaryContainer ?: OpenAGIColors.inkDark,
    tertiaryContainer = dynamic?.tertiaryContainer ?: OpenAGIColors.surfaceDark,
    onTertiaryContainer = dynamic?.onTertiaryContainer ?: OpenAGIColors.inkDark,
    error = OpenAGIColors.alertDark,
    onError = OpenAGIColors.inkDark,
    errorContainer = OpenAGIColors.alertDark.copy(alpha = 0.16f),
    onErrorContainer = OpenAGIColors.alertDark,
    background = OpenAGIColors.canvasDark,
    onBackground = OpenAGIColors.inkDark,
    surface = OpenAGIColors.surfaceDark,
    onSurface = OpenAGIColors.inkDark,
    surfaceVariant = OpenAGIColors.surfaceDark,
    onSurfaceVariant = OpenAGIColors.mutedDark,
    outline = OpenAGIColors.edgeDark,
    outlineVariant = OpenAGIColors.edgeDark,
)

@Composable
fun OpenAGITheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val dynamic = if (dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else {
        null
    }
    val colorScheme = if (darkTheme) darkScheme(dynamic) else lightScheme(dynamic)
    val extra = if (darkTheme) {
        OpenAGIExtraColors(OpenAGIColors.liveDark, OpenAGIColors.alertDark, OpenAGIColors.edgeDark)
    } else {
        OpenAGIExtraColors(OpenAGIColors.liveLight, OpenAGIColors.alertLight, OpenAGIColors.edgeLight)
    }

    // Status/navigation bar icons default to whatever the (dark) native
    // window theme picked, regardless of which mode Compose actually
    // resolved — on a light `canvas` that leaves white-on-white status bar
    // icons. Follow the resolved theme instead every time it changes.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            val controller = WindowCompat.getInsetsController(window, view)
            controller.isAppearanceLightStatusBars = !darkTheme
            controller.isAppearanceLightNavigationBars = !darkTheme
        }
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalOpenAGIColors provides extra) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = OpenAGIType.material,
        ) {
            // MaterialTheme itself paints nothing — it only provides the
            // colour scheme via composition locals. Without this Surface, any
            // screen not already wrapped in a Scaffold (Pairing, most
            // notably) shows the raw Activity window background instead of
            // `canvas`, and worse, if that window background happens to be
            // dark while the resolved scheme is light (or vice versa),
            // `onBackground` text renders with no contrast against it at
            // all — the bug a real device/emulator screenshot caught here.
            Surface(modifier = Modifier.fillMaxSize(), color = colorScheme.background) {
                content()
            }
        }
    }
}
