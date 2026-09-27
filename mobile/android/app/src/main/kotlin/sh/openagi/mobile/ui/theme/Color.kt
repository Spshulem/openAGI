package sh.openagi.mobile.ui.theme

import androidx.compose.ui.graphics.Color

// DESIGN.md's six tokens, both modes, plus the `edge` hairline. Nothing else
// belongs in this file: DESIGN.md is explicit that there are six values per
// mode and nothing more, and that `live`/`alert` never change hue with the
// wallpaper, so they are not sourced from dynamic colour.
//
// One exception: `caution`, the Supervisor's yellow health dot, which needs a
// third status hue between `live` and `alert`. Amber dark enough to hold 4.5:1
// on `surface` in both modes, and fixed like them (FEATURES.md "Supervisor").
object OpenAGIColors {
    // Light
    val canvasLight = Color(0xFFF1F3F2)
    val surfaceLight = Color(0xFFFFFFFF)
    val inkLight = Color(0xFF13171A)
    val mutedLight = Color(0xFF5C6763)
    val liveLight = Color(0xFF0E6F4E)
    val alertLight = Color(0xFFA32C22)
    val edgeLight = Color(0xFFE2E6E4)
    val cautionLight = Color(0xFF8A5A00)

    // Dark
    val canvasDark = Color(0xFF0E1211)
    val surfaceDark = Color(0xFF171C1A)
    val inkDark = Color(0xFFECEFED)
    val mutedDark = Color(0xFF93A09A)
    val liveDark = Color(0xFF4BC48D)
    val alertDark = Color(0xFFF08A7E)
    val edgeDark = Color(0xFF262D2A)
    val cautionDark = Color(0xFFE8B64C)

    val white = Color(0xFFFFFFFF)
}
