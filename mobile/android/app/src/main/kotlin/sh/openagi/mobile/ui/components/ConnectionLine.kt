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
import androidx.compose.ui.text.style.TextOverflow
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

    // Chat only. DESIGN.md: "The connection line on this screen reads `live`
    // while the event stream is attached and `reconnecting` when it is not —
    // the one screen where that distinction is worth the words." Every other
    // screen's connection line answers "how stale is the last sync"; this
    // one answers "is a reply actively streaming right now."
    data class Live(val host: String) : ConnectionState()
    data class Reconnecting(val host: String) : ConnectionState()
}

// The dot's colour and whether it is filled, shared by the connection line and
// the chat top bar's status dot so the two can never disagree.
@Composable
internal fun connectionDotStyle(state: ConnectionState): Pair<androidx.compose.ui.graphics.Color, Boolean> {
    val colors = LocalOpenAGIColors.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    return when (state) {
        is ConnectionState.Synced -> if (state.ageMinutes < 60) colors.live to true else muted to false
        is ConnectionState.Failed -> colors.alert to true
        is ConnectionState.NeverSynced -> muted to false
        is ConnectionState.Live -> colors.live to true
        is ConnectionState.Reconnecting -> muted to false
    }
}

// The daemon's address, whatever the state.
internal fun connectionHost(state: ConnectionState): String = (when (state) {
    is ConnectionState.Synced -> state.host
    is ConnectionState.Failed -> state.host
    is ConnectionState.NeverSynced -> state.host
    is ConnectionState.Live -> state.host
    is ConnectionState.Reconnecting -> state.host
}).let { if (it.startsWith("http://127.0.0.1:")) "This phone" else it }

// The status word the connection line shows after the host.
internal fun connectionCaption(state: ConnectionState): String = when (state) {
    is ConnectionState.Synced -> RelativeTime.short(state.ageMinutes)
    is ConnectionState.Failed -> "can't reach"
    is ConnectionState.NeverSynced -> "not synced yet"
    is ConnectionState.Live -> "live"
    is ConnectionState.Reconnecting -> "reconnecting"
}

@Composable
fun ConnectionLine(state: ConnectionState, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    val (dotColor, dotFilled) = connectionDotStyle(state)
    val host = connectionHost(state)
    val caption = connectionCaption(state)

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
            // The status word is the part that must survive. Unweighted, it is
            // measured first and keeps its full width; the host takes what is
            // left and ellipsizes. Without this the Row handed the host every
            // pixel it asked for and wrapped "reconnecting" down the right
            // edge one letter per line on a narrow (folded) screen.
            Text(
                text = host,
                style = OpenAGIType.dataMono,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text(text = "  ·  ", style = OpenAGIType.caption, maxLines = 1, softWrap = false)
            Text(text = caption, style = OpenAGIType.caption, maxLines = 1, softWrap = false)
        }
    }
}
