package sh.openagi.mobile.fallback

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.util.Locale

// The installed revision and download size are controlled by Google AICore.
// Never infer a size or percentage when the SDK hasn't reported a total.
data class LocalModelProgress(
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val gettingReady: Boolean = false,
) {
    val fraction: Float?
        get() = if (!gettingReady && totalBytes != null && totalBytes > 0)
            (downloadedBytes.toDouble() / totalBytes).coerceIn(0.0, 1.0).toFloat() else null

    val description: String
        get() = when {
            gettingReady -> "Download complete · getting Gemini Nano ready…"
            totalBytes != null && totalBytes > 0 -> "${(fraction!! * 100).toInt()}% · ${megabytes(downloadedBytes)} of ${megabytes(totalBytes)} MB"
            downloadedBytes > 0 -> "${megabytes(downloadedBytes)} MB downloaded · waiting for total size"
            else -> "Waiting for Google AICore to start the download…"
        }

    private fun megabytes(bytes: Long) = String.format(Locale.getDefault(), "%.1f", bytes / 1_000_000.0)
}

@Composable
internal fun LocalModelCard(
    note: String,
    progress: LocalModelProgress?,
    working: Boolean,
    canPrepare: Boolean,
    needsDownload: Boolean,
    onPrepare: () -> Unit,
    onCancel: (() -> Unit)?,
) {
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Gemini Nano", style = MaterialTheme.typography.titleMedium)
            Text("On-device model · managed by Google AICore", style = MaterialTheme.typography.bodyMedium)
            Text("Download Gemini Nano to this phone through Google AICore. No server or API key is needed. Google chooses the model version and which phones support it.", style = MaterialTheme.typography.bodySmall)
            Text("After setup, replies are generated on this phone. This separate chat does not sync your server’s Today, Tasks or Inbox.", style = MaterialTheme.typography.bodySmall)
            Text(progress?.description ?: note, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            if (working) {
                val fraction = progress?.fraction
                if (fraction == null) LinearProgressIndicator(Modifier.fillMaxWidth())
                else LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
                Text("Keep an internet connection for the first download. Setup may take several minutes. You can leave or choose another provider.", style = MaterialTheme.typography.bodySmall)
                if (onCancel != null) TextButton(onClick = onCancel) { Text("Cancel setup") }
            } else {
                OutlinedButton(enabled = canPrepare, onClick = onPrepare) {
                    Text(if (needsDownload) "Download Gemini Nano" else "Check Gemini Nano availability")
                }
            }
        }
    }
}
