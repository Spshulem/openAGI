package sh.openagi.mobile.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import sh.openagi.mobile.protocol.AnswerClarificationRequest
import sh.openagi.mobile.protocol.AnswerClarificationResult
import sh.openagi.mobile.protocol.ApprovalResult
import sh.openagi.mobile.protocol.Clarification
import sh.openagi.mobile.protocol.CreateTaskRequest
import sh.openagi.mobile.protocol.DenyRequest
import sh.openagi.mobile.protocol.DenyResult
import sh.openagi.mobile.protocol.Enrollment
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.PendingAction
import sh.openagi.mobile.protocol.PendingActionsResponse
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.protocol.SendMessageRequest
import sh.openagi.mobile.protocol.Task
import sh.openagi.mobile.protocol.TasksListResponse
import sh.openagi.mobile.protocol.UpdateTaskRequest
import kotlinx.serialization.builtins.ListSerializer
import java.util.concurrent.TimeUnit

// nodeId is validated upstream against ^[a-zA-Z0-9:_-]{1,240}$ and cannot carry
// a quote or backslash, but `name` is a free-text device name the user typed —
// hand-interpolating it into a JSON string literal would let a name like
// `","platform":"x` smuggle a duplicate key into the request. Routing it
// through the serializer instead means it is escaped the same way any other
// string field is.
@Serializable
private data class EnrollRequest(
    val code: String,
    val platform: String = "mobile",
    val nodeId: String,
    val nodeToken: String,
    val name: String,
)

sealed class DaemonException(message: String) : Exception(message) {
    class UnreachableHost(host: String) : DaemonException("a phone cannot reach $host")
    class Unauthorized : DaemonException("the node credential was refused")
    class NotFound : DaemonException("the daemon does not know that id")
    class Conflict : DaemonException("the daemon has already moved on")
    class Server(val code: Int) : DaemonException("the daemon returned $code")
    class Malformed : DaemonException("the daemon returned something unreadable")
    // The network itself failed: no connection, a timeout, DNS, TLS. Carries the
    // cause for diagnosis, and never the token — DaemonException's message is
    // built from the host and status only. `cause` overrides Throwable.cause
    // (narrowed to non-null IOException); Kotlin requires the `override`
    // keyword here or this fails to compile as "hides member of supertype".
    class Transport(override val cause: java.io.IOException) : DaemonException("the daemon could not be reached: ${cause.message}")
}

sealed class SummaryResponse {
    object Unchanged : SummaryResponse()
    data class Fresh(val summary: MobileSummary, val etag: String?) : SummaryResponse()
}

class DaemonClient(
    private val server: String,
    private val nodeId: String,
    private val token: String,
    private val client: OkHttpClient = defaultClient,
    private val enforceAllowlist: Boolean = true,
) {
    // SSE reads can legitimately go 15+ seconds between bytes — PROTOCOL.md
    // §7's own ": ping" cadence is every 15s, and a chat reply can think for
    // longer than that between deltas. `client`'s ordinary read timeout
    // (12s on defaultClient) exists for normal request/response calls and
    // would otherwise fire spuriously mid-stream. Only the two streaming
    // calls below use this; every other method keeps `client` unchanged.
    private val streamingClient: OkHttpClient by lazy {
        client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    }

    suspend fun summary(ifNoneMatch: String?): SummaryResponse = withContext(Dispatchers.IO) {
        val builder = authorized("/mobile/summary").get()
        if (ifNoneMatch != null) builder.header("If-None-Match", ifNoneMatch)
        try {
            client.newCall(builder.build()).execute().use { response ->
                ensureOk(response)
                if (response.code == 304) return@withContext SummaryResponse.Unchanged
                val body = response.body?.string() ?: throw DaemonException.Malformed()
                val summary = try {
                    ProtocolJson.json.decodeFromString(MobileSummary.serializer(), body)
                } catch (error: Exception) {
                    throw DaemonException.Malformed()
                }
                SummaryResponse.Fresh(summary, response.header("ETag"))
            }
        } catch (io: java.io.IOException) {
            throw DaemonException.Transport(io)
        }
    }

    suspend fun complete(taskId: String) = post("/tasks/$taskId/complete", """{"completedVia":"mobile"}""")

    // ─── Tasks (FEATURES.md "Tasks": the full manager, not a filtered view) ──

    suspend fun tasks(queue: String = "user", bucket: String? = null, status: String? = null, limit: Int? = null): List<Task> {
        val query = buildMap {
            put("queue", queue)
            bucket?.let { put("bucket", it) }
            status?.let { put("status", it) }
            limit?.let { put("limit", it.toString()) }
        }
        return getJson("/tasks", query, TasksListResponse.serializer()).tasks
    }

    suspend fun createTask(request: CreateTaskRequest): Task =
        postJson("/tasks", CreateTaskRequest.serializer(), request, Task.serializer())

    suspend fun getTask(id: String): Task = getJson("/tasks/$id", emptyMap(), Task.serializer())

    suspend fun updateTask(id: String, request: UpdateTaskRequest): Task =
        patchJson("/tasks/$id", UpdateTaskRequest.serializer(), request, Task.serializer())

    // Completing via /tasks/:id/complete returns the full updated task, unlike
    // the bare complete() above (kept as-is: RefreshCoordinator's outbound
    // queue only ever needs to know the call succeeded, not the result).
    suspend fun completeTask(taskId: String): Task = withContext(Dispatchers.IO) {
        val request = authorized("/tasks/$taskId/complete")
            .post("""{"completedVia":"mobile"}""".toRequestBody(JSON))
            .build()
        decode(execute(request), Task.serializer())
    }

    suspend fun deleteTask(id: String): Boolean = withContext(Dispatchers.IO) {
        val request = authorized("/tasks/$id").delete().build()
        try {
            client.newCall(request).execute().use { response ->
                // The daemon's own 404 here already means "not found" (it
                // returns { ok: false, id } with a 404 status), so ensureOk's
                // usual NotFound mapping is exactly right — no separate body
                // parse needed for the failure case.
                ensureOk(response)
                true
            }
        } catch (io: java.io.IOException) {
            throw DaemonException.Transport(io)
        }
    }

    // ─── Pending actions (FEATURES.md "Inbox": approvals) ────────────────────

    suspend fun pendingActions(status: String? = "pending"): List<PendingAction> {
        val query = if (status != null) mapOf("status" to status) else emptyMap()
        return getJson("/pending-actions", query, PendingActionsResponse.serializer()).actions
    }

    // Not routed through execute()/decode(): the daemon returns 400 (not just
    // 200) with a legitimate `{ok:false, error:"..."}` body when the approved
    // tool itself failed to run — src/hosted-interface.js's approve handler
    // returns `invokeResult.ok ? 200 : 400`. Discarding that body on 400 the
    // way ensureOk normally would means the Inbox could only ever say "the
    // daemon returned 400" instead of the tool's real failure reason.
    suspend fun approveAction(id: String): ApprovalResult = withContext(Dispatchers.IO) {
        val request = authorized("/pending-actions/$id/approve").post("".toRequestBody(JSON)).build()
        try {
            client.newCall(request).execute().use { response ->
                when (response.code) {
                    200, 400 -> decode(response.body?.string() ?: throw DaemonException.Malformed(), ApprovalResult.serializer())
                    401, 403 -> throw DaemonException.Unauthorized()
                    404 -> throw DaemonException.NotFound()
                    409 -> throw DaemonException.Conflict()
                    else -> throw DaemonException.Server(response.code)
                }
            }
        } catch (io: java.io.IOException) {
            throw DaemonException.Transport(io)
        }
    }

    suspend fun denyAction(id: String, reason: String? = null): DenyResult =
        postJson("/pending-actions/$id/deny", DenyRequest.serializer(), DenyRequest(reason), DenyResult.serializer())

    // ─── Clarifications (FEATURES.md "Inbox": questions the agent has asked) ─

    suspend fun clarifications(status: String? = "pending"): List<Clarification> {
        val query = if (status != null) mapOf("status" to status) else emptyMap()
        // Unlike every other list route here, this one's body is a bare JSON
        // array, not an {"...": [...]} envelope — see src/clarification-store.js.
        return getJsonList("/tasks/clarifications", query, Clarification.serializer())
    }

    // The daemon only accepts one of ClarificationAnswer's four literal
    // values and 400s (DaemonException.Server(400)) on anything else.
    suspend fun answerClarification(id: String, answer: String): AnswerClarificationResult =
        postJson(
            "/tasks/clarifications/$id/answer",
            AnswerClarificationRequest.serializer(),
            AnswerClarificationRequest(answer),
            AnswerClarificationResult.serializer(),
        )

    // ─── Chat (FEATURES.md "Chat": POST /message, streamed) ──────────────────

    // A cold Flow, not suspend: each collection opens its own connection and
    // reads frames as streamLocalMessage (src/hosted-interface.js) writes
    // them — status/session/heartbeat/delta/final/failure — until the daemon
    // closes the stream. `Accept: text/event-stream` is what selects this
    // richer streaming reply over the plain single-JSON-object response the
    // same route gives a caller that doesn't ask for it.
    fun sendMessageStream(text: String, from: String? = null, sessionId: String? = null): Flow<SseFrame> {
        val body = ProtocolJson.json.encodeToString(SendMessageRequest.serializer(), SendMessageRequest(text, from, sessionId))
        val request = authorized("/message")
            .header("Accept", "text/event-stream")
            .post(body.toRequestBody(JSON))
            .build()
        return streamingClient.streamSse(request)
    }

    // ─── Background events (PROTOCOL.md §7: GET /events) ─────────────────────

    // Long-lived, reconnected by the caller (EventStream) with backoff — this
    // is one connection attempt's worth of frames.
    fun events(): Flow<SseFrame> {
        val request = authorized("/events").header("Accept", "text/event-stream").get().build()
        return streamingClient.streamSse(request)
    }

    private suspend fun <T> getJson(path: String, query: Map<String, String>, serializer: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val request = authorized(path, query).get().build()
            decode(execute(request), serializer)
        }

    private suspend fun <T> getJsonList(path: String, query: Map<String, String>, elementSerializer: KSerializer<T>): List<T> =
        withContext(Dispatchers.IO) {
            val request = authorized(path, query).get().build()
            decode(execute(request), ListSerializer(elementSerializer))
        }

    private suspend fun <B, T> postJson(path: String, bodySerializer: KSerializer<B>, body: B, resultSerializer: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val requestBody = ProtocolJson.json.encodeToString(bodySerializer, body).toRequestBody(JSON)
            val request = authorized(path).post(requestBody).build()
            decode(execute(request), resultSerializer)
        }

    private suspend fun <B, T> patchJson(path: String, bodySerializer: KSerializer<B>, body: B, resultSerializer: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val requestBody = ProtocolJson.json.encodeToString(bodySerializer, body).toRequestBody(JSON)
            val request = authorized(path).patch(requestBody).build()
            decode(execute(request), resultSerializer)
        }

    // Executes and returns the raw body text, translating both HTTP status
    // (via ensureOk) and any IOException into a DaemonException the same way
    // summary()/post() above already do — the one difference from post() is
    // that this keeps the body instead of discarding it.
    private fun execute(request: Request): String = try {
        client.newCall(request).execute().use { response ->
            ensureOk(response)
            response.body?.string() ?: throw DaemonException.Malformed()
        }
    } catch (io: java.io.IOException) {
        throw DaemonException.Transport(io)
    }

    private fun <T> decode(body: String, serializer: KSerializer<T>): T = try {
        ProtocolJson.json.decodeFromString(serializer, body)
    } catch (error: Exception) {
        throw DaemonException.Malformed()
    }

    // role is required and must be exactly "node". The name is deliberately
    // omitted: the daemon stores the name this node enrolled with and ignores
    // anything the wire claims, so sending one could only ever disagree.
    suspend fun heartbeat() = post("/nodes/heartbeat", """{"nodeId":"$nodeId","role":"node"}""")

    suspend fun revoke() = post("/nodes/revoke", """{"nodeId":"$nodeId"}""")

    private suspend fun post(path: String, json: String) = withContext(Dispatchers.IO) {
        val request = authorized(path).post(json.toRequestBody(JSON)).build()
        // An IOException here is a dropped connection, a timeout, a DNS failure —
        // on a phone, the most likely failure of all. It must arrive as a
        // DaemonException like every other, or callers that catch DaemonException
        // miss precisely the case that happens most. iOS shipped this gap first
        // and had to add a transport case for the same reason.
        try {
            client.newCall(request).execute().use { ensureOk(it) }
        } catch (io: java.io.IOException) {
            throw DaemonException.Transport(io)
        }
        Unit
    }

    private fun authorized(path: String, query: Map<String, String> = emptyMap()): Request.Builder {
        val urlBuilder = origin().newBuilder().encodedPath(path)
        query.forEach { (key, value) -> urlBuilder.addQueryParameter(key, value) }
        return Request.Builder()
            .url(urlBuilder.build())
            .header("Authorization", "Bearer $token")
            .header("X-OpenAGI-Node-ID", nodeId)
    }

    private fun origin(): HttpUrl =
        if (enforceAllowlist) HostAllowlist.validate(server)
        else server.toHttpUrlOrNull() ?: throw DaemonException.UnreachableHost(server)

    companion object {
        private val JSON = "application/json".toMediaType()

        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build()

        // Enrollment happens before any credential exists, so it is a companion
        // function and carries only the one-time code.
        suspend fun enroll(
            server: String,
            code: String,
            nodeId: String,
            nodeToken: String,
            name: String,
            client: OkHttpClient = defaultClient,
            enforceAllowlist: Boolean = true,
        ): Enrollment = withContext(Dispatchers.IO) {
            val origin = if (enforceAllowlist) HostAllowlist.validate(server)
            else server.toHttpUrlOrNull() ?: throw DaemonException.UnreachableHost(server)
            val body = ProtocolJson.json.encodeToString(
                EnrollRequest.serializer(),
                EnrollRequest(code = code, nodeId = nodeId, nodeToken = nodeToken, name = name),
            )
            val request = Request.Builder()
                .url(origin.newBuilder().encodedPath("/nodes/enroll/exchange").build())
                .post(body.toRequestBody(JSON))
                .build()
            try {
                client.newCall(request).execute().use { response ->
                    when (response.code) {
                        200 -> ProtocolJson.json.decodeFromString(
                            Enrollment.serializer(),
                            response.body?.string() ?: throw DaemonException.Malformed()
                        )
                        401, 403, 429 -> throw DaemonException.Unauthorized()
                        409 -> throw DaemonException.Conflict()
                        else -> throw DaemonException.Server(response.code)
                    }
                }
            } catch (io: java.io.IOException) {
                throw DaemonException.Transport(io)
            }
        }

        // Named ensureOk, not check: kotlin.check already means something else,
        // and a shadowed stdlib name is a bug waiting to be misread.
        internal fun ensureOk(response: Response) {
            when (response.code) {
                in 200..299, 304 -> Unit
                401, 403 -> throw DaemonException.Unauthorized()
                404 -> throw DaemonException.NotFound()
                409 -> throw DaemonException.Conflict()
                else -> throw DaemonException.Server(response.code)
            }
        }
    }
}
