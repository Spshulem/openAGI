package sh.openagi.mobile.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.transport.DaemonException
import java.io.IOException

class ErrorCopyTest {
    @Test
    fun aWrongPairingCodeNamesTheFixNotTheStatusCode() {
        val message = ErrorCopy.forPairing(DaemonException.Unauthorized(), "mac.tail1234.ts.net")
        assertEquals("That code didn't work.", message.headline)
        assertTrue(message.detail.contains("30 minutes"))
    }

    @Test
    fun aRefusedHostNamesWhyRatherThanJustTheHostString() {
        val message = ErrorCopy.forPairing(DaemonException.UnreachableHost("127.0.0.1"), "127.0.0.1")
        assertEquals("That address can't be reached from a phone.", message.headline)
        assertTrue(message.detail.contains("Loopback"))
    }

    @Test
    fun aTransportFailureNamesTheHostThatDidNotAnswer() {
        val message = ErrorCopy.forPairing(DaemonException.Transport(IOException("boom")), "mac.tail1234.ts.net:43210")
        assertEquals("Can't reach OpenAGI.", message.headline)
        assertTrue(message.detail.contains("mac.tail1234.ts.net:43210"))
    }

    @Test
    fun aRevokedTokenTellsSomeoneToRepairRatherThanShowingARawStatus() {
        val message = ErrorCopy.forDaemon(DaemonException.Unauthorized(), "mac.ts.net")
        assertEquals("Needs re-pairing.", message.headline)
        assertTrue(message.detail.contains("Settings"))
    }

    @Test
    fun noMessageEverReadsLikeAGenericApology() {
        val banned = listOf("oops", "something went wrong", "please try again later")
        val allDaemonMessages = listOf(
            ErrorCopy.forPairing(DaemonException.Unauthorized(), "h"),
            ErrorCopy.forPairing(DaemonException.UnreachableHost("h"), "h"),
            ErrorCopy.forPairing(DaemonException.Conflict(), "h"),
            ErrorCopy.forPairing(DaemonException.Transport(IOException("x")), "h"),
            ErrorCopy.forPairing(DaemonException.NotFound(), "h"),
            ErrorCopy.forPairing(DaemonException.Malformed(), "h"),
            ErrorCopy.forPairing(DaemonException.Server(500), "h"),
            ErrorCopy.forDaemon(DaemonException.Unauthorized(), "h"),
            ErrorCopy.forDaemon(DaemonException.Transport(IOException("x")), "h"),
            ErrorCopy.forDaemon(DaemonException.UnreachableHost("h"), "h"),
            ErrorCopy.forDaemon(DaemonException.NotFound(), "h"),
            ErrorCopy.forDaemon(DaemonException.Conflict(), "h"),
            ErrorCopy.forDaemon(DaemonException.Malformed(), "h"),
            ErrorCopy.forDaemon(DaemonException.Server(500), "h"),
        )
        allDaemonMessages.forEach { message ->
            val text = (message.headline + " " + message.detail).lowercase()
            banned.forEach { phrase -> assertTrue("'$phrase' found in '$text'", !text.contains(phrase)) }
        }
    }
}
