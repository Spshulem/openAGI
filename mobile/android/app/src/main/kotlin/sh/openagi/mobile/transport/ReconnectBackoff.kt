package sh.openagi.mobile.transport

import kotlin.math.min
import kotlin.math.pow

// FEATURES.md: "Reconnect with backoff when the stream drops. Never silently
// stay dead." Pure arithmetic, no coroutines/Handler involved, so the curve
// itself is directly testable: doubling from a 1s floor, capped at 30s, with
// the attempt count reset by the caller on any successfully-received frame.
object ReconnectBackoff {
    private const val FLOOR_MS = 1_000L
    private const val CAP_MS = 30_000L

    // attempt is 0-based: the delay before the first reconnect try.
    fun delayMillis(attempt: Int): Long {
        if (attempt <= 0) return FLOOR_MS
        val scaled = FLOOR_MS * 2.0.pow(attempt.coerceAtMost(20))
        return min(CAP_MS.toDouble(), scaled).toLong()
    }
}
