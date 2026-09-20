package sh.openagi.mobile.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

// Five small hand-drawn glyphs for the bottom NavigationBar, one per
// FEATURES.md destination. No icon library dependency: each is a handful of
// Canvas primitives at a fixed 22dp, tinted by the caller (selected/muted)
// rather than baking colour in — the same approach TaskRow's checkmark uses.
enum class NavIcon { TODAY, TASKS, INBOX, CHAT, SETTINGS }

@Composable
fun NavIconGlyph(icon: NavIcon, tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier.size(22.dp)) {
        val stroke = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        when (icon) {
            NavIcon.TODAY -> {
                // A day square with one filled corner tick — "today" as a
                // marked calendar cell, distinct from the tasks list glyph.
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(size.width * 0.15f, size.height * 0.15f),
                    size = androidx.compose.ui.geometry.Size(size.width * 0.7f, size.height * 0.7f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.width * 0.12f),
                    style = stroke,
                )
                drawCircle(color = tint, radius = size.minDimension * 0.08f, center = center)
            }
            NavIcon.TASKS -> {
                // Three list lines of decreasing length.
                val xStart = size.width * 0.2f
                listOf(0.32f, 0.5f, 0.68f).forEachIndexed { index, fy ->
                    val xEnd = size.width * (if (index == 2) 0.6f else 0.8f)
                    drawLine(tint, Offset(xStart, size.height * fy), Offset(xEnd, size.height * fy), strokeWidth = stroke.width, cap = StrokeCap.Round)
                }
            }
            NavIcon.INBOX -> {
                // A tray: a wide U with a horizontal slot line, like a
                // physical inbox tray.
                val path = Path().apply {
                    moveTo(size.width * 0.15f, size.height * 0.35f)
                    lineTo(size.width * 0.15f, size.height * 0.78f)
                    lineTo(size.width * 0.85f, size.height * 0.78f)
                    lineTo(size.width * 0.85f, size.height * 0.35f)
                }
                drawPath(path, color = tint, style = stroke)
                drawLine(tint, Offset(size.width * 0.15f, size.height * 0.5f), Offset(size.width * 0.38f, size.height * 0.5f), strokeWidth = stroke.width, cap = StrokeCap.Round)
                drawLine(tint, Offset(size.width * 0.62f, size.height * 0.5f), Offset(size.width * 0.85f, size.height * 0.5f), strokeWidth = stroke.width, cap = StrokeCap.Round)
            }
            NavIcon.CHAT -> {
                // A speech bubble: rounded rect with a small tail.
                drawRoundRect(
                    color = tint,
                    topLeft = Offset(size.width * 0.15f, size.height * 0.2f),
                    size = androidx.compose.ui.geometry.Size(size.width * 0.7f, size.height * 0.5f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.width * 0.16f),
                    style = stroke,
                )
                val tail = Path().apply {
                    moveTo(size.width * 0.32f, size.height * 0.68f)
                    lineTo(size.width * 0.32f, size.height * 0.85f)
                    lineTo(size.width * 0.48f, size.height * 0.68f)
                }
                drawPath(tail, color = tint, style = stroke)
            }
            NavIcon.SETTINGS -> {
                // A gear: a ring with four short radial ticks.
                val r = size.minDimension * 0.28f
                drawCircle(color = tint, radius = r, center = center, style = stroke)
                for (i in 0 until 4) {
                    val angle = Math.toRadians((i * 90).toDouble())
                    val inner = Offset(
                        (center.x + (r + 1.dp.toPx()) * kotlin.math.cos(angle)).toFloat(),
                        (center.y + (r + 1.dp.toPx()) * kotlin.math.sin(angle)).toFloat(),
                    )
                    val outer = Offset(
                        (center.x + (r + 5.dp.toPx()) * kotlin.math.cos(angle)).toFloat(),
                        (center.y + (r + 5.dp.toPx()) * kotlin.math.sin(angle)).toFloat(),
                    )
                    drawLine(tint, inner, outer, strokeWidth = stroke.width, cap = StrokeCap.Round)
                }
            }
        }
    }
}
