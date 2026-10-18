package sh.openagi.mobile.ui.components

// Window coordinates are converted to local dp before resolving panes. A
// hinge is physical: RTL changes which pane leads, never where the gap sits.
internal enum class FoldAxis { VERTICAL, HORIZONTAL }

internal data class PaneBounds(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top
}

internal data class FoldInfo(val bounds: PaneBounds, val axis: FoldAxis)
internal data class PaneLayout(val main: PaneBounds, val supporting: PaneBounds? = null)

internal fun usesNavigationRail(width: Float, height: Float, tabletop: Boolean): Boolean =
    width >= 600f && height >= 480f && !tabletop

internal fun paneLayout(
    width: Float,
    height: Float,
    fold: FoldInfo?,
    supporting: Boolean,
    expanded: Boolean,
    rtl: Boolean = false,
): PaneLayout {
    val full = PaneBounds(0f, 0f, width, height)
    if (fold != null) {
        val gap = fold.bounds
        when (fold.axis) {
            FoldAxis.VERTICAL -> if (gap.left > 0f && gap.right < width && gap.bottom > 0f && gap.top < height) {
                val left = PaneBounds(0f, 0f, gap.left, height)
                val right = PaneBounds(gap.right, 0f, width, height)
                return PaneLayout(if (rtl) right else left, if (supporting) { if (rtl) left else right } else null)
            }
            FoldAxis.HORIZONTAL -> if (gap.top > 0f && gap.bottom < height && gap.right > 0f && gap.left < width) {
                return PaneLayout(PaneBounds(0f, 0f, width, gap.top),
                    if (supporting) PaneBounds(0f, gap.bottom, width, height) else null)
            }
        }
    }
    if (supporting && expanded && width >= 656f && height >= 480f) {
        val supportingWidth = maxOf(320f, (width - 16f) * 0.4f)
        val mainWidth = width - supportingWidth - 16f
        return if (rtl) PaneLayout(PaneBounds(supportingWidth + 16f, 0f, width, height), PaneBounds(0f, 0f, supportingWidth, height))
        else PaneLayout(PaneBounds(0f, 0f, mainWidth, height), PaneBounds(mainWidth + 16f, 0f, width, height))
    }
    return PaneLayout(full)
}
