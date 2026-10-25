package sh.openagi.mobile.embedded

import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.genai.common.GenAiException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.MainActivity
import sh.openagi.mobile.fallback.LocalChat
import sh.openagi.mobile.store.Credentials
import java.util.concurrent.TimeUnit

// Explicit physical-device acceptance, separate from emulator coverage.
// Run with -e nanoAcceptance true. No keys or user messages enter the report.
@RunWith(AndroidJUnit4::class)
class GeminiNanoAcceptanceTest {
    @Test fun nanoAnswersDirectlyAndThroughTheLocalDaemon() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nanoAcceptance") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val previous = Credentials.load(context)
        val http = OkHttpClient.Builder().callTimeout(150, TimeUnit.SECONDS).build()
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                val status = withTimeout(30_000) { LocalChat.status() }
                Log.i("OpenAGINanoAcceptance", "AICore feature status=$status")
                val direct = withTimeout(120_000) { LocalChat.generate("Please reply with a short greeting.") }
                assertTrue("Gemini Nano must produce a real response", direct.isNotBlank())
                Log.i("OpenAGINanoAcceptance", "Direct Gemini Nano inference passed")
                val local = EmbeddedAgent.start(context, previous)
                val request = Request.Builder().url(local.server + "/message")
                    .header("Authorization", "Bearer ${local.token}").header("X-OpenAGI-Node-ID", local.nodeId)
                    // A separate synthetic conversation, never the owner's chat.
                    .post("""{"text":"Please reply with a short greeting.","from":"nano-acceptance","channel":"local"}""".toRequestBody("application/json".toMediaType())).build()
                http.newCall(request).execute().use { response ->
                    assertEquals("The local agent must answer through Gemini Nano; see the private daemon log for a failure", 200, response.code)
                    val body = Json.parseToJsonElement(response.body!!.string()).jsonObject
                    assertTrue("The local agent must return an answer", body["reply"]?.jsonPrimitive?.content.orEmpty().isNotBlank())
                }
                Log.i("OpenAGINanoAcceptance", "Local-daemon Gemini Nano inference passed")
            }
        } catch (error: Exception) {
            val cause = error.cause ?: error
            Log.e("OpenAGINanoAcceptance", "Acceptance failed: type=${cause.javaClass.name}; sdkCode=${(cause as? GenAiException)?.errorCode}; frames=${cause.stackTrace.take(6).joinToString()}")
            throw error
        } finally {
            if (previous != null) Credentials.save(context, previous)
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }
}
