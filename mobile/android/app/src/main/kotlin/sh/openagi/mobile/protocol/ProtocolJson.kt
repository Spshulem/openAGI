package sh.openagi.mobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import java.time.Instant

// The daemon speaks ISO-8601 with a Z, sometimes with fractional seconds.
// java.time.Instant.parse handles both, and minSdk 31 means it is always there.
object InstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("java.time.Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())

    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

object ProtocolJson {
    val json: Json = Json {
        // A daemon that grows a field must not brick every installed phone.
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
}
