package sh.openagi.mobile.ui.components

import android.net.Uri
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import sh.openagi.mobile.ui.theme.OpenAGIType

// Shown when an openagi://pair link arrives while this phone is already
// paired. Names both machines by host — the one thing a person needs to
// decide whether this link is the switch they meant to make. Switch is the
// destructive action (it forgets the current pairing), so it carries the
// `alert` colour via DestructiveTextButton; Cancel is plain.
@Composable
fun SwitchDaemonDialog(
    currentServer: String,
    incomingServer: String,
    onSwitch: () -> Unit,
    onCancel: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Switch to another OpenAGI?", style = OpenAGIType.section) },
        text = {
            Text(
                "This phone is connected to ${hostOf(currentServer)}. " +
                    "Pairing with ${hostOf(incomingServer)} disconnects it here.",
                style = OpenAGIType.body,
            )
        },
        confirmButton = { DestructiveTextButton(text = "Switch", onClick = onSwitch) },
        dismissButton = {
            TextButton(onClick = onCancel) { Text("Cancel", style = OpenAGIType.body) }
        },
    )
}

private fun hostOf(server: String): String = Uri.parse(server).host ?: server
