package sh.openagi.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// DESIGN.md's type scale, on the system face (Roboto — no downloaded webfont;
// a bundled font on a native app is the tell of a cross-platform shell). Sizes
// map onto the Material3 roles this app actually uses; the two monospace
// roles ("Data" and "Code entry") are not part of the Typography slot system
// so they live as standalone TextStyles applied where DESIGN.md reserves
// monospace: host address, pairing code, node/task ids — never body copy.
object OpenAGIType {
    private val sans = FontFamily.SansSerif
    private val mono = FontFamily.Monospace

    // Screen title: 34 semibold, one per screen, left aligned.
    val screenTitle = TextStyle(fontFamily = sans, fontWeight = FontWeight.SemiBold, fontSize = 34.sp, lineHeight = 40.sp)

    // Section: 20 semibold.
    val section = TextStyle(fontFamily = sans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp)

    // Body: 17 regular. Task titles.
    val body = TextStyle(fontFamily = sans, fontWeight = FontWeight.Normal, fontSize = 17.sp, lineHeight = 22.sp)

    // Secondary: 15 regular, muted.
    val secondary = TextStyle(fontFamily = sans, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 20.sp)

    // Caption: 13 regular, muted. The connection line.
    val caption = TextStyle(fontFamily = sans, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp)

    // Data (mono): 13 regular. Host, code, ids.
    val dataMono = TextStyle(fontFamily = mono, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp)

    // Code entry (mono): 28 medium, tracked +2. Pairing code field only.
    val codeEntry = TextStyle(
        fontFamily = mono,
        fontWeight = FontWeight.Medium,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = 0.07.em,
    )

    // The Material3 slots the app draws through MaterialTheme.typography.
    // Sentence case everywhere, no all-caps labels — nothing here uses
    // labelSmall's usual all-caps convention; callers set text as written.
    val material = Typography(
        headlineLarge = screenTitle,
        titleLarge = section,
        bodyLarge = body,
        bodyMedium = secondary,
        bodySmall = caption,
        labelLarge = body,
        labelMedium = secondary,
        labelSmall = caption,
    )
}
