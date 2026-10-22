package sh.openagi.mobile.fallback

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

enum class FallbackProvider(val title: String, val defaultModel: String) {
    LOCAL("Gemini Nano", "gemini-nano"), OPENAI("OpenAI", "gpt-5-mini"),
    ANTHROPIC("Claude", "claude-sonnet-4-6"), OPENROUTER("OpenRouter", "openai/gpt-5-mini"),
    GEMINI("Gemini", "gemini-2.5-flash"),
}

@Serializable
data class FallbackLine(val role: String, val text: String)

class FallbackException(message: String) : IOException(message)

// Fixed HTTPS destinations, no redirects, no shared daemon credentials. A
// provider change starts a different chat; server history is never uploaded.
object FallbackTransport {
    const val INSTRUCTIONS = "You are OpenAGI in direct chat mode. Help with writing, reasoning and planning. You have no access to the user's server, tasks, integrations, files or tools. Never claim to have performed actions there."
    internal val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(90, TimeUnit.SECONDS).build()

    fun request(provider: FallbackProvider, model: String, key: String, lines: List<FallbackLine>): Request {
        if (provider == FallbackProvider.LOCAL || key.isBlank() || key.any { it == '\n' || it == '\r' } ||
            model.isBlank() || model.length > 160 || model.any { it.isWhitespace() }) {
            throw FallbackException("Choose a model and save its API key first.")
        }
        fun messages() = buildJsonArray {
            lines.takeLast(20).forEach { line -> add(buildJsonObject { put("role", line.role); put("content", line.text.take(12000)) }) }
        }
        val endpoint: String
        val body: JsonObject
        when (provider) {
            FallbackProvider.OPENAI -> {
                endpoint = "https://api.openai.com/v1/responses"
                body = buildJsonObject { put("model", model); put("instructions", INSTRUCTIONS); put("input", messages()); put("store", false); put("max_output_tokens", 2048) }
            }
            FallbackProvider.ANTHROPIC -> {
                endpoint = "https://api.anthropic.com/v1/messages"
                body = buildJsonObject { put("model", model); put("system", INSTRUCTIONS); put("messages", messages()); put("max_tokens", 2048) }
            }
            FallbackProvider.OPENROUTER -> {
                endpoint = "https://openrouter.ai/api/v1/chat/completions"
                body = buildJsonObject {
                    put("model", model); put("max_tokens", 2048)
                    put("messages", buildJsonArray {
                        add(buildJsonObject { put("role", "system"); put("content", INSTRUCTIONS) })
                        messages().forEach { add(it) }
                    })
                }
            }
            FallbackProvider.GEMINI -> {
                if (!model.matches(Regex("[a-zA-Z0-9._-]+"))) throw FallbackException("Enter a Gemini model ID, without a URL or path.")
                endpoint = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent"
                body = buildJsonObject {
                    put("systemInstruction", buildJsonObject { put("parts", buildJsonArray { add(buildJsonObject { put("text", INSTRUCTIONS) }) }) })
                    put("contents", buildJsonArray {
                        lines.takeLast(20).forEach { line -> add(buildJsonObject {
                            put("role", if (line.role == "assistant") "model" else "user")
                            put("parts", buildJsonArray { add(buildJsonObject { put("text", line.text.take(12000)) }) })
                        }) }
                    })
                    put("generationConfig", buildJsonObject { put("maxOutputTokens", 2048) })
                }
            }
            FallbackProvider.LOCAL -> throw FallbackException("The local model doesn't use a network connection.")
        }
        val request = Request.Builder().url(endpoint).post(body.toString().toRequestBody("application/json".toMediaType()))
        when (provider) {
            FallbackProvider.ANTHROPIC -> request.header("x-api-key", key).header("anthropic-version", "2023-06-01")
            FallbackProvider.GEMINI -> request.header("x-goog-api-key", key)
            else -> request.header("Authorization", "Bearer $key")
        }
        return request.build()
    }

    fun decode(body: String, provider: FallbackProvider): String {
        val obj = Json.parseToJsonElement(body).jsonObject
        fun JsonElement?.objects() = (this as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        fun JsonElement?.text() = (this as? JsonPrimitive)?.contentOrNull
        val text = when (provider) {
            FallbackProvider.OPENAI -> obj["output"].objects().flatMap { it["content"].objects() }
                .filter { it["type"].text() == "output_text" }.mapNotNull { it["text"].text() }.joinToString("\n")
            FallbackProvider.ANTHROPIC -> obj["content"].objects().filter { it["type"].text() == "text" }.mapNotNull { it["text"].text() }.joinToString("\n")
            FallbackProvider.OPENROUTER -> (obj["choices"].objects().firstOrNull()?.get("message") as? JsonObject)?.get("content").text().orEmpty()
            FallbackProvider.GEMINI -> ((obj["candidates"].objects().firstOrNull()?.get("content") as? JsonObject)?.get("parts")).objects().mapNotNull { it["text"].text() }.joinToString("\n")
            FallbackProvider.LOCAL -> ""
        }
        if (text.isBlank()) throw FallbackException("The model returned no text. Try a shorter message or another model.")
        return text
    }

    suspend fun reply(provider: FallbackProvider, model: String, key: String, lines: List<FallbackLine>): String {
        val request = request(provider, model, key, lines)
        val body = suspendCancellableCoroutine<String> { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (!continuation.isCancelled) continuation.resumeWithException(FallbackException("Couldn't reach the provider. Check your internet connection or choose the local model.")) }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            if (!response.isSuccessful) throw FallbackException(when (response.code) {
                                401, 403 -> "The provider rejected this API key. Replace it in Chat options."
                                429 -> "The provider's quota or rate limit was reached. Try later or choose the local model."
                                else -> "The provider couldn't reply (HTTP ${response.code}). Your server pairing is preserved."
                            })
                            val value = response.body?.string() ?: throw FallbackException("The provider returned an empty reply.")
                            continuation.resume(value)
                        } catch (e: Exception) { if (!continuation.isCancelled) continuation.resumeWithException(FallbackException(if (e is FallbackException) e.message.orEmpty() else "Couldn't read the provider's reply.")) }
                    }
                }
            })
        }
        return decode(body, provider)
    }
}
