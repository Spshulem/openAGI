package sh.openagi.mobile.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import sh.openagi.mobile.protocol.Enrollment
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.ProtocolJson
import java.util.concurrent.TimeUnit

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

    private fun authorized(path: String): Request.Builder =
        Request.Builder()
            .url(origin().newBuilder().encodedPath(path).build())
            .header("Authorization", "Bearer $token")
            .header("X-OpenAGI-Node-ID", nodeId)

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
            val body = """{"code":"$code","platform":"mobile","nodeId":"$nodeId","nodeToken":"$nodeToken","name":"$name"}"""
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
