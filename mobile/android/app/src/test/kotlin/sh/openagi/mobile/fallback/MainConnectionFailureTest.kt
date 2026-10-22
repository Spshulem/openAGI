package sh.openagi.mobile.fallback

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.util.ErrorCopy

class MainConnectionFailureTest {
    @Test fun workerFailureKeepsPhonePairingAndGivesActionableCopy() {
        listOf("main-pairing-required", "main-unavailable", "main-routing-loop").forEach { code ->
            val response = Response.Builder().request(Request.Builder().url("https://worker.example.test/mobile/summary").build())
                .protocol(Protocol.HTTP_1_1).code(502).message("Bad gateway")
                .body("""{"error":"$code"}""".toResponseBody()).build()
            val failure = assertThrows(DaemonException.MainUnavailable::class.java) { DaemonClient.ensureOk(response) }
            assertEquals(code == "main-pairing-required", failure.pairingRequired)
            val copy = ErrorCopy.forDaemon(failure, "worker.example.test")
            assertTrue(copy.detail.contains("phone pairing"))
            assertFalse(copy.detail.contains("Revoke"))
        }
    }
}
