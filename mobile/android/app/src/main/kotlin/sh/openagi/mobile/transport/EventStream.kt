package sh.openagi.mobile.transport

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

// FEATURES.md's Chat screen: "The connection line doubles as the stream
// indicator: filled while the SSE stream is attached... Reconnect with
// backoff when the stream drops. Never silently stay dead." This wraps
// DaemonClient.events() (a single connection attempt) into a Flow that never
// completes on its own: any failure reconnects after ReconnectBackoff's
// delay, and the attempt counter resets the moment a frame actually arrives,
// so a stream that drops once after being healthy for an hour doesn't start
// its next reconnect at the back of a long backoff.
//
// `onAttachedChange` is the "filled while attached" half of that: true once a
// connection delivers its first frame (the daemon opens every stream with
// `hello`), false the moment that connection ends or fails. Chat once
// inferred this from whether a reply happened to be streaming, and so read
// "reconnecting" over a perfectly healthy stream nearly all the time.
class EventStream(
    private val onAttachedChange: (Boolean) -> Unit = {},
    private val connectOnce: () -> Flow<SseFrame>,
) {
    // The real constructor callers use; a DaemonClient's events() is a
    // function reference so this class carries no OkHttp/Android dependency
    // of its own — connectOnce is the only seam a test needs to fake.
    constructor(client: DaemonClient, onAttachedChange: (Boolean) -> Unit = {}) :
        this(onAttachedChange, { client.events() })

    fun connect(): Flow<SseFrame> = flow {
        var attempt = 0
        while (true) {
            var attached = false
            try {
                connectOnce().collect { frame ->
                    attempt = 0
                    if (!attached) {
                        attached = true
                        onAttachedChange(true)
                    }
                    emit(frame)
                }
                // The server closed the stream cleanly (no exception) — still
                // worth backing off before redialing rather than hot-looping.
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                // DaemonException.Unauthorized included: a phone whose token
                // was revoked mid-stream still just backs off and retries: the
                // caller (Settings/pairing state) is the source of truth for
                // "should we even be connected," not this loop.
            } finally {
                if (attached) onAttachedChange(false)
            }
            delay(ReconnectBackoff.delayMillis(attempt))
            attempt++
        }
    }
}
