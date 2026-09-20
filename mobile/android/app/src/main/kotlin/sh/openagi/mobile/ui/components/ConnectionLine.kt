package sh.openagi.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType
import sh.openagi.mobile.util.RelativeTime

// DESIGN.md's "connection line": a dot, the host in mono, a relative time in
// caption. It appears under every screen title and is the app's honest,
// always-visible answer to "is the daemon alive right now" — never a modal,
// never animated when the state changes.
sealed class ConnectionState {
    data class Synced(val host: String, val ageMinutes: Int) : ConnectionState()
    data class Failed(val host: String, val ageMinutes: Int?) : ConnectionState()
    data class NeverSynced(val host: String) : ConnectionState()
}

@Composable
fun ConnectionLine(state: ConnectionState, modifier: Modifier = Modifier) {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    val (dotColor, dotFilled) = when (state) {
        is ConnectionState.Synced -> if (state.ageMinutes < 60) colors.live to true else muted to false
        is ConnectionState.Failed -> colors.alert to true
        is ConnectionState.NeverSynced -> muted to false
    }
    val (host, caption) = when (state) {
        is ConnectionState.Synced -> state.host to RelativeTime.short(state.ageMinutes)
        is ConnectionState.Failed -> state.host to "can't reach"
        is ConnectionState.NeverSynced -> state.host to "not synced yet"
    }

    Row(modifier = modifier) {
        val dotModifier = Modifier
            .padding(top = 6.dp, end = 8.dp)
            .size(6.dp)
            .clip(CircleShape)
        if (dotFilled) {
            androidx.compose.foundation.layout.Box(dotModifier.background(dotColor))
        } else {
            androidx.compose.foundation.layout.Box(dotModifier.border(1.dp, dotColor, CircleShape))
        }
        CompositionLocalProvider(LocalContentColor provides muted) {
            Text(text = host, style = OpenAGIType.dataMono)
            Text(text = "  ·  ", style = OpenAGIType.caption)
            Text(text = caption, style = OpenAGIType.caption)
        }
    }
}
