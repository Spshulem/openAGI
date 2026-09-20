package sh.openagi.mobile.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.LocalOpenAGIColors
import sh.openagi.mobile.ui.theme.OpenAGIType

// DESIGN.md: "Filled `live`, white text, radius 10, 50 tall, full width."
// Button copy names the action and keeps the name through the flow (the
// caller passes the current label — "Pair" -> "Paired" — rather than this
// component inventing state text or appending an arrow).
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
) {
    val colors = LocalOpenAGIColors.current
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = colors.live,
            contentColor = androidx.compose.ui.graphics.Color.White,
            disabledContainerColor = colors.live.copy(alpha = 0.4f),
            disabledContentColor = androidx.compose.ui.graphics.Color.White,
        ),
        modifier = modifier.fillMaxWidth().height(50.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.height(20.dp),
                color = androidx.compose.ui.graphics.Color.White,
                strokeWidth = 2.dp,
            )
        } else {
            Text(text, style = OpenAGIType.body)
        }
    }
}

// DESIGN.md: "Text only, `alert`. Never a filled red button — revoke is rare
// and should not look like the primary path."
@Composable
fun DestructiveTextButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val colors = LocalOpenAGIColors.current
    TextButton(onClick = onClick, enabled = enabled, modifier = modifier) {
        Text(text, style = OpenAGIType.body, color = colors.alert)
    }
}
