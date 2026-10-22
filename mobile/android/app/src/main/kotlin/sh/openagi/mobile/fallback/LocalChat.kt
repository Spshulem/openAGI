package sh.openagi.mobile.fallback

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.prompt.Generation

// AICore performs inference on the phone. Availability is checked at runtime;
// Android version or a foldable model name is never treated as proof of it.
object LocalChat {
    suspend fun status(): Int {
        val model = Generation.getClient()
        return try { model.checkStatus() } finally { model.close() }
    }

    suspend fun download(progress: (String) -> Unit) {
        val model = Generation.getClient()
        try {
            model.download().collect { state ->
                when (state) {
                    is DownloadStatus.DownloadStarted -> progress("Downloading Gemini Nano…")
                    is DownloadStatus.DownloadProgress -> progress("Downloaded ${state.totalBytesDownloaded / 1_000_000} MB…")
                    is DownloadStatus.DownloadFailed -> throw FallbackException("The local model couldn't download. Check Wi-Fi and try again.")
                    DownloadStatus.DownloadCompleted -> progress("Ready on this phone")
                }
            }
        } finally { model.close() }
    }

    suspend fun reply(lines: List<FallbackLine>): String {
        val model = Generation.getClient()
        try {
            if (model.checkStatus() != FeatureStatus.AVAILABLE) throw FallbackException("Gemini Nano isn't ready on this phone. Open Chat options to check or download it, or choose a hosted provider.")
            val prompt = FallbackTransport.INSTRUCTIONS + "\n\n" + lines.takeLast(8).joinToString("\n") { "${it.role}: ${it.text.takeLast(1200)}" } + "\nassistant:"
            val result = model.generateContent(prompt).candidates.firstOrNull()?.text.orEmpty()
            if (result.isBlank()) throw FallbackException("The local model returned no text. Try a shorter message.")
            return result
        } finally { model.close() }
    }
}
