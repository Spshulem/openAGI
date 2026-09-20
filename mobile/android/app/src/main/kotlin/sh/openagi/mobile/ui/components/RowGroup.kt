package sh.openagi.mobile.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors

// DESIGN.md: "Rows sit on `surface` in grouped blocks with 12 corner radius
// and hairline separators between — not as individually floating cards with
// shadows." One radius value (12dp), zero elevation, ever.
@Composable
fun RowGroup(modifier: Modifier = Modifier, content: @Composable ColumnScopeWithDivider.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Column {
            val scope = ColumnScopeWithDivider()
            scope.content()
        }
    }
}

// A tiny scope so callers can drop a hairline between rows without importing
// HorizontalDivider and re-deriving the `edge` colour at every call site.
class ColumnScopeWithDivider {
    @Composable
    fun Hairline() {
        HorizontalDivider(color = LocalOpenAGIColors.current.edge, thickness = 1.dp)
    }
}
