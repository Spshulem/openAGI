package sh.openagi.mobile.embedded

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import sh.openagi.mobile.fallback.LocalChat

// Loopback-only, authenticated with this installation's encrypted owner key.
// Gemini Nano chooses a tool; the daemon validates and runs it through the
// normal registry/approval path. The model never executes phone actions.
internal class DeviceModelBridge(private val scope: CoroutineScope, private val port: Int, private val owner: String) {
    private val client = OkHttpClient.Builder().readTimeout(0, java.util.concurrent.TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var wanted = true
    private val running = java.util.concurrent.ConcurrentHashMap<String, Job>()
    @Synchronized fun connect() {
        wanted = true
        if (socket != null) return
        socket = client.newWebSocket(Request.Builder().url("ws://127.0.0.1:$port/device/model")
            .header("Authorization", "Bearer $owner").build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(buildJsonObject { put("type", "hello"); put("model", "Gemini Nano"); put("contextSize", 4096) }.toString())
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                val id = frame["id"]?.jsonPrimitive?.content ?: return
                when (frame["type"]?.jsonPrimitive?.content) {
                    "cancel" -> running.remove(id)?.cancel()
                    "generate" -> {
                        running[id] = scope.launch {
                            try {
                                val result = DeviceModelPrompts.result(LocalChat.generate(DeviceModelPrompts.render(frame)), frame)
                                webSocket.send(buildJsonObject { put("type", "result"); put("id", id); result.forEach { (key, value) -> put(key, value) } }.toString())
                            } catch (error: CancellationException) { throw error }
                            catch (_: Exception) {
                                webSocket.send(buildJsonObject { put("type", "error"); put("id", id); put("code", "device-model-unavailable")
                                    put("message", "Gemini Nano couldn't reply. Check or download the local model in Chat options. Your tasks and history stay on this phone.") }.toString())
                            } finally { running.remove(id) }
                        }
                    }
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { dropped(webSocket) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { dropped(webSocket) }
        })
    }
    @Synchronized private fun dropped(old: WebSocket) {
        if (socket !== old) return
        socket = null
        running.values.forEach { it.cancel() }; running.clear()
        if (wanted) scope.launch { delay(2000); if (wanted) connect() }
    }
    @Synchronized fun close() {
        wanted = false
        socket?.cancel(); socket = null
        running.values.forEach { it.cancel() }; running.clear()
    }
}

internal object DeviceModelPrompts {
    fun render(frame: JsonObject): String = buildString {
        appendLine(frame["system"]?.jsonPrimitive?.content.orEmpty())
        val tools = frame["tools"]?.jsonArray.orEmpty()
        if (tools.isNotEmpty()) {
            appendLine("Choose exactly one next step. Reply only with JSON: {\"text\":\"your answer\"} or {\"toolCall\":{\"name\":\"tool name\",\"arguments\":{...}}}. Use tools for actions; never claim an action happened before seeing its result.")
            appendLine("Available tools: $tools")
        } else appendLine("Reply to the user's current request using the tool results. Do not call a tool.")
        frame["messages"]?.jsonArray.orEmpty().forEach { message ->
            val row = message.jsonObject
            appendLine("${row["role"]?.jsonPrimitive?.content}: ${row["content"]?.jsonPrimitive?.content.orEmpty()}")
            row["toolCall"]?.let { appendLine("Tool call: $it") }
        }
    }

    fun result(text: String, frame: JsonObject): JsonObject {
        val clean = text.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
        val decoded = runCatching { Json.parseToJsonElement(clean).jsonObject }.getOrNull()
        val call = decoded?.get("toolCall")?.jsonObject
        if (call != null) {
            val name = call["name"]?.jsonPrimitive?.content
            require(frame["tools"]?.jsonArray.orEmpty().any { it.jsonObject["name"]?.jsonPrimitive?.content == name }) { "Unknown tool" }
            require(call["arguments"] is JsonObject) { "Invalid tool arguments" }
            return buildJsonObject { put("toolCall", call) }
        }
        val answer = decoded?.get("text")?.jsonPrimitive?.content ?: text.trim()
        require(answer.isNotBlank()) { "Empty model response" }
        return buildJsonObject { put("text", answer) }
    }
}
