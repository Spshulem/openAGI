package sh.openagi.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
