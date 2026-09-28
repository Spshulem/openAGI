package sh.openagi.mobile.protocol

import kotlinx.serialization.Serializable
import java.time.Instant

// GET /lifelog/moments (PROTOCOL.md §3.2): retained G2 conversation moments
// across every enrolled G2, newest first. Read-only; the transcript is the
// captured words and is untrusted text, shown, never acted on.
@Serializable
data class LifelogMoment(
    val id: String,
    val nodeId: String,
    val deviceName: String = "Even G2",
    @Serializable(with = InstantSerializer::class) val at: Instant,
    @Serializable(with = OptionalInstantSerializer::class) val endAt: Instant? = null,
    val title: String = "",
    val summary: String? = null,
    val transcript: String = "",
)

@Serializable
data class LifelogMomentsResponse(val moments: List<LifelogMoment> = emptyList())
