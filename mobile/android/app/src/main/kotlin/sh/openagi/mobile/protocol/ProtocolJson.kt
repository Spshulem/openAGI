package sh.openagi.mobile.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import java.time.Instant

// The daemon speaks ISO-8601 with a Z, sometimes with fractional seconds —
// and a task's dueDate is often a bare calendar date, "2026-07-01", because
// that is what a person or the agent actually set. Every fixture used full
// timestamps, so Instant.parse alone passed every test and then threw on the
// first real brain it met: the whole summary failed to decode and the app
// showed "Nothing left today" over fifty open tasks. A bare date is read as
// the start of that day in UTC; `overdue` is computed by the daemon, so this
// only ever feeds display, never the overdue decision itself.
object InstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("java.time.Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())

    override fun deserialize(decoder: Decoder): Instant = parseProtocolInstant(decoder.decodeString())
}

// For OPTIONAL dates only. The task store holds "" for a cleared due date and
// /tasks returns it raw, so an empty or malformed value must mean "no date",
// not "fail the whole payload" — one bad field was enough to blank the Today
// screen over fifty real tasks. Required dates (generatedAt, fetchedAt) keep
// the strict serializer above, because a payload without one is genuinely
// broken and should say so.
@OptIn(ExperimentalSerializationApi::class)
object OptionalInstantSerializer : KSerializer<Instant?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("java.time.Instant.optional", PrimitiveKind.STRING).nullable

    override fun serialize(encoder: Encoder, value: Instant?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(value.toString())
    }

    override fun deserialize(decoder: Decoder): Instant? {
        if (!decoder.decodeNotNullMark()) return decoder.decodeNull()
        val raw = decoder.decodeString()
        return if (raw.isBlank()) null else runCatching { parseProtocolInstant(raw) }.getOrNull()
    }
}

internal fun parseProtocolInstant(raw: String): Instant =
    if (BARE_DATE.matches(raw)) java.time.LocalDate.parse(raw).atStartOfDay(java.time.ZoneOffset.UTC).toInstant()
    else Instant.parse(raw)

private val BARE_DATE = Regex("""^\d{4}-\d{2}-\d{2}$""")

object ProtocolJson {
    val json: Json = Json {
        // A daemon that grows a field must not brick every installed phone.
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
}
