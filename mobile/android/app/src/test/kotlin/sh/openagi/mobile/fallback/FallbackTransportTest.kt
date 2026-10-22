package sh.openagi.mobile.fallback

import kotlinx.serialization.json.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class FallbackTransportTest {
    private val lines = listOf(FallbackLine("user", "Help me plan tomorrow"))
    @Test fun providerKeysOnlyGoToFixedHttpsDestinations() {
        val hosts = mapOf(FallbackProvider.OPENAI to "api.openai.com", FallbackProvider.ANTHROPIC to "api.anthropic.com", FallbackProvider.OPENROUTER to "openrouter.ai", FallbackProvider.GEMINI to "generativelanguage.googleapis.com")
        hosts.forEach { (provider, host) ->
            val request = FallbackTransport.request(provider, provider.defaultModel, "unit-test-credential", lines)
            assertEquals("https", request.url.scheme)
            assertEquals(host, request.url.host)
            assertNull(request.url.query)
            assertNull(request.header("X-OpenAGI-Node-ID"))
            val buffer = Buffer(); request.body!!.writeTo(buffer)
            val body = buffer.readUtf8()
            assertFalse(body.contains("unit-test-credential"))
            assertTrue(body.contains("Help me plan tomorrow"))
        }
        assertFalse(FallbackTransport.http.followRedirects)
        assertFalse(FallbackTransport.http.followSslRedirects)
    }
    @Test fun openAiDoesNotStoreResponses() {
        val request = FallbackTransport.request(FallbackProvider.OPENAI, "gpt-5-mini", "unit-test-credential", lines)
        val buffer = Buffer(); request.body!!.writeTo(buffer)
        assertEquals(false, Json.parseToJsonElement(buffer.readUtf8()).jsonObject["store"]!!.jsonPrimitive.boolean)
    }
    @Test fun localNeverMakesNetworkRequestAndGeminiRejectsPaths() {
        assertThrows(FallbackException::class.java) { FallbackTransport.request(FallbackProvider.LOCAL, "local", "unit-test-credential", lines) }
        listOf("../outside", "evil.example/a", "gemini?key=other").forEach { model ->
            assertThrows(FallbackException::class.java) { FallbackTransport.request(FallbackProvider.GEMINI, model, "unit-test-credential", lines) }
        }
    }
    @Test fun allProviderRepliesDecodeAndEmptyRepliesAreErrors() {
        val replies = mapOf(
            FallbackProvider.OPENAI to """{"output":[{"content":[{"type":"output_text","text":"Hello"}]}]}""",
            FallbackProvider.ANTHROPIC to """{"content":[{"type":"text","text":"Hello"}]}""",
            FallbackProvider.OPENROUTER to """{"choices":[{"message":{"content":"Hello"}}]}""",
            FallbackProvider.GEMINI to """{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}""",
        )
        replies.forEach { (provider, body) ->
            assertEquals("Hello", FallbackTransport.decode(body, provider))
            assertThrows(FallbackException::class.java) { FallbackTransport.decode("{}", provider) }
        }
    }
}
