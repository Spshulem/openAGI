package sh.openagi.mobile.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.OpenAGIType

// DESIGN.md: "Centred, a single line of `ink` plus a line of `muted`. No
// illustration, no icon larger than 28pt." — and the copy rules: an empty
// state invites action, an error says what to do next.
@Composable
fun EmptyState(headline: String, detail: String? = null, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(headline, style = OpenAGIType.body, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
        if (detail != null) {
            Text(
                detail,
                style = OpenAGIType.secondary,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}
