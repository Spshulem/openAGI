package sh.openagi.mobile.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.OpenAGIType

// DESIGN.md: "Every screen carries a quiet connection line directly under
// its title." One 34-semibold title, left aligned, then the connection line.
// The 20dp screen gutter and 8pt grid spacing live here so every screen gets
// it for free instead of re-deriving it.
@Composable
fun ScreenHeader(title: String, connection: ConnectionState, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Text(title, style = OpenAGIType.screenTitle, color = MaterialTheme.colorScheme.onBackground)
        ConnectionLine(connection, modifier = Modifier.padding(top = 4.dp))
    }
}
