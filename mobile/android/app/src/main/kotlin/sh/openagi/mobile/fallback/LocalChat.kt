package sh.openagi.mobile.fallback

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext

// AICore performs inference on the phone. Availability is checked at runtime;
// Android version or a foldable model name is never treated as proof of it.
object LocalChat {
    private val runner = LocalChatRunner(createClient = { AICoreClient() })

    suspend fun status(): Int = runner.status()
    fun download(): Flow<LocalModelProgress> = runner.download()
    suspend fun reply(lines: List<FallbackLine>): String = runner.reply(lines)
    suspend fun generate(prompt: String): String = runner.generate(prompt)
}

internal interface LocalGenerationClient : AutoCloseable {
    suspend fun status(): Int
    fun download(): Flow<DownloadStatus>
    suspend fun generate(prompt: String): String
}

private class AICoreClient : LocalGenerationClient {
    private val model = Generation.getClient()
    override suspend fun status(): Int = model.checkStatus()
    override fun download(): Flow<DownloadStatus> = model.download()
    override suspend fun generate(prompt: String): String =
        model.generateContent(prompt).candidates.firstOrNull()?.text.orEmpty()
    override fun close() = model.close()
}

internal class LocalChatRunner(
    private val createClient: () -> LocalGenerationClient,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    // Client creation and close can block too. Keep the entire SDK lifecycle
    // off Main, rather than relying on its suspend methods to yield promptly.
    suspend fun status(): Int = withContext(dispatcher) {
        val model = createClient()
        try { model.status() } finally { model.close() }
    }

    fun download(): Flow<LocalModelProgress> = flow {
        val model = createClient()
        var totalBytes: Long? = null
        var downloadedBytes = 0L
        try {
            model.download().collect { state ->
                when (state) {
                    is DownloadStatus.DownloadStarted -> {
                        totalBytes = state.bytesToDownload.takeIf { it > 0 }
                        emit(LocalModelProgress(totalBytes = totalBytes))
                    }
                    is DownloadStatus.DownloadProgress -> {
                        downloadedBytes = state.totalBytesDownloaded.coerceAtLeast(0)
                        emit(LocalModelProgress(downloadedBytes, totalBytes))
                    }
                    is DownloadStatus.DownloadFailed -> throw FallbackException("Gemini Nano couldn't download. Check Wi-Fi and try again.")
                    DownloadStatus.DownloadCompleted -> emit(LocalModelProgress(downloadedBytes, totalBytes, gettingReady = true))
                }
            }
        } finally { model.close() }
    }.flowOn(dispatcher) // Collectors update Compose state on their own context.

    suspend fun generate(prompt: String): String = withContext(dispatcher) {
        val model = createClient()
        try {
            if (model.status() != FeatureStatus.AVAILABLE) throw FallbackException("Gemini Nano isn't ready on this phone.")
            model.generate(prompt).also { if (it.isBlank()) throw FallbackException("The local model returned no text.") }
        } finally { model.close() }
    }

    suspend fun reply(lines: List<FallbackLine>): String = withContext(dispatcher) {
        val model = createClient()
        try {
            if (model.status() != FeatureStatus.AVAILABLE) throw FallbackException("Gemini Nano isn't ready on this phone. Open Chat options to check or download it, or choose a hosted provider.")
            val prompt = FallbackTransport.INSTRUCTIONS + "\n\n" + lines.takeLast(8).joinToString("\n") { "${it.role}: ${it.text.takeLast(1200)}" } + "\nassistant:"
            val result = model.generate(prompt)
            if (result.isBlank()) throw FallbackException("The local model returned no text. Try a shorter message.")
            result
        } finally { model.close() }
    }
}
