package sh.openagi.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// PairingPayload.from(Uri) itself needs android.net.Uri, an unmockable
// framework stub under plain JUnit — so this exercises fromParts, the pure
// logic it delegates to, directly. This is the test the whole-branch review
// flagged as missing entirely.
class PairingPayloadTest {
    private fun parts(url: String?, code: String?): (String) -> String? = { key ->
        when (key) {
            "url" -> url
            "code" -> code
            else -> null
        }
    }

    @Test
    fun aWellFormedLinkParses() {
        val payload = PairingPayload.fromParts("openagi", "pair", parts("https://mac.tail1234.ts.net", "831343"))
        assertEquals(PairingPayload("https://mac.tail1234.ts.net", "831343"), payload)
    }

    @Test
    fun wrongSchemeIsRejected() {
        assertNull(PairingPayload.fromParts("https", "pair", parts("https://mac.ts.net", "831343")))
    }

    @Test
    fun wrongHostIsRejected() {
        assertNull(PairingPayload.fromParts("openagi", "unpair", parts("https://mac.ts.net", "831343")))
    }

    @Test
    fun missingUrlIsRejected() {
        assertNull(PairingPayload.fromParts("openagi", "pair", parts(null, "831343")))
    }

    @Test
    fun missingCodeIsRejected() {
        assertNull(PairingPayload.fromParts("openagi", "pair", parts("https://mac.ts.net", null)))
    }

    @Test
    fun aCodeThatIsNotSixDigitsIsRejected() {
        listOf("12345", "1234567", "12a456", "").forEach { code ->
            assertNull(PairingPayload.fromParts("openagi", "pair", parts("https://mac.ts.net", code)))
        }
    }

    @Test
    fun aLinkNamingTheDaemonWeAreAlreadyOnIsNotASwitch() {
        val server = "https://distiller.tail1234.ts.net:8443"
        assertTrue(PairingPayload.namesSameDaemon(server, server))
        // Cosmetic differences a link can pick up on the way in -- a trailing
        // slash, a shouted host -- still name the same machine.
        assertTrue(PairingPayload.namesSameDaemon(server, "$server/"))
        assertTrue(PairingPayload.namesSameDaemon(server, server.uppercase()))
    }

    @Test
    fun aLinkNamingAnotherDaemonIsASwitch() {
        val distiller = "https://distiller.tail1234.ts.net:8443"
        assertFalse(PairingPayload.namesSameDaemon(distiller, "http://192.0.2.20:43311"))
        // Same host, different port is a different daemon -- a scratch build
        // on a spare port is the whole reason the switch prompt exists.
        assertFalse(PairingPayload.namesSameDaemon(distiller, "https://distiller.tail1234.ts.net:9443"))
    }
}
