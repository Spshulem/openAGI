package sh.openagi.mobile.transport

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

// Shared streaming primitive behind both DaemonClient.events() (GET /events,
// long-lived, background) and DaemonClient.sendMessageStream() (POST
// /message with Accept: text/event-stream, one reply per call). Both read an
// OkHttp response body as a stream and hand each line to SseFrameParser —
// this is that reading loop, factored out once rather than duplicated. No
// new dependency: this is plain OkHttp (the response body's BufferedSource)
// plus the pure parser above.
internal fun OkHttpClient.streamSse(request: Request): Flow<SseFrame> = callbackFlow {
    val call = newCall(request)
    val response = try {
        call.execute()
    } catch (io: IOException) {
        close(DaemonException.Transport(io))
        return@callbackFlow
    }
    if (response.code !in 200..299) {
        val code = response.code
        response.close()
        close(
            when (code) {
                401, 403 -> DaemonException.Unauthorized()
                404 -> DaemonException.NotFound()
                else -> DaemonException.Server(code)
            },
        )
        return@callbackFlow
    }
    val source = response.body?.source()
    if (source == null) {
        response.close()
        close(DaemonException.Malformed())
        return@callbackFlow
    }
    val parser = SseFrameParser()
    try {
        while (isActive) {
            val line = source.readUtf8Line() ?: break // the server closed the stream
            parser.feed(line)?.let { trySend(it) }
        }
        close()
    } catch (io: IOException) {
        close(DaemonException.Transport(io))
    } finally {
        response.close()
    }
    awaitClose {
        call.cancel()
        response.close()
    }
}.flowOn(kotlinx.coroutines.Dispatchers.IO)
