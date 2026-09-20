package sh.openagi.mobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType

// DESIGN.md's task row: title in body, a second line only when there is
// something to say, and a trailing completion control that is the one place
// this app spends any boldness. Everything else about the row is quiet.
@Composable
fun TaskRow(
    title: String,
    subtitle: String? = null,
    subtitleIsAlert: Boolean = false,
    isCompleting: Boolean,
    reducedMotion: Boolean,
    onComplete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOpenAGIColors.current
    val duration = if (reducedMotion) 0 else 220
    val textAlpha by animateFloatAsState(if (isCompleting) 0.4f else 1f, tween(duration), label = "taskTextAlpha")

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(60.dp)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f).alpha(textAlpha)) {
            Text(title, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface)
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = OpenAGIType.caption,
                    color = if (subtitleIsAlert) colors.alert else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        CompletionControl(
            title = title,
            isCompleting = isCompleting,
            reducedMotion = reducedMotion,
            onTap = onComplete,
        )
    }
}

// A 44x44 tap target around a 22pt hollow circle that fills `live` and draws
// a checkmark on completion — DESIGN.md's one orchestrated moment. The
// control itself never disappears; the row around it does, in the caller's
// list animation.
@Composable
private fun CompletionControl(
    title: String,
    isCompleting: Boolean,
    reducedMotion: Boolean,
    onTap: () -> Unit,
) {
    val colors = LocalOpenAGIColors.current
    val duration = if (reducedMotion) 0 else 220
    val fill by animateFloatAsState(if (isCompleting) 1f else 0f, tween(duration), label = "completionFill")

    Box(
        modifier = Modifier
            .size(44.dp)
            .semantics { contentDescription = "Complete $title" }
            .clickable(enabled = !isCompleting, onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .then(
                    if (fill > 0f) {
                        Modifier.background(colors.live.copy(alpha = fill))
                    } else {
                        Modifier.border(1.5.dp, MaterialTheme.colorScheme.onSurfaceVariant, CircleShape)
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (fill > 0.3f) {
                val checkAlpha = ((fill - 0.3f) / 0.7f).coerceIn(0f, 1f)
                Canvas(modifier = Modifier.size(14.dp).alpha(checkAlpha)) {
                    val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                    val path = androidx.compose.ui.graphics.Path().apply {
                        moveTo(size.width * 0.12f, size.height * 0.52f)
                        lineTo(size.width * 0.42f, size.height * 0.82f)
                        lineTo(size.width * 0.88f, size.height * 0.22f)
                    }
                    drawPath(path, color = Color.White, style = stroke)
                }
            }
        }
    }
}
