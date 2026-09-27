package sh.openagi.mobile.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class HostAllowlistTest {
    @Test
    fun tailnetAndLanCleartextAreAllowed() {
        listOf(
            "http://mac.tail1234.ts.net:43210",
            "http://100.101.102.103:43210",
            "http://192.168.1.20:43210",
            "http://10.0.0.5:43210",
            "http://172.16.4.4:43210",
        ).forEach { raw ->
            HostAllowlist.validate(raw) // must not throw
        }
    }

    @Test
    fun publicCleartextIsRefused() {
        listOf(
            "http://openagi.example.com",
            "http://8.8.8.8:43210",
            // 172.32 is outside the private range even though it looks close.
            "http://172.32.0.1:43210",
        ).forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }

    @Test
    fun httpsIsAlwaysAllowed() {
        assertEquals("openagi.example.com", HostAllowlist.validate("https://openagi.example.com").host)
    }

    @Test
    fun nonHttpSchemesAreRefused() {
        listOf("ftp://mac.ts.net", "file:///etc/passwd", "not a url").forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }

    @Test
    fun trailingPathsAreDroppedSoRequestPathsAreNotDoubled() {
        assertEquals(
            "http://mac.ts.net:43210/",
            HostAllowlist.validate("http://mac.ts.net:43210/setup").toString()
        )
    }

    @Test
    fun loopbackIsRefusedWhateverTheScheme() {
        // https must be refused too. A loopback address is the daemon's own
        // default bind, so it is the single likeliest thing to be pasted into
        // pairing by mistake, and a phone can never reach it.
        listOf(
            "http://127.0.0.1:43210",
            "https://127.0.0.1:43210",
            "http://localhost:43210",
            "https://localhost:43210",
        ).forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }

    @Test
    fun cidrBoundaryNearMissesAreRefused() {
        // Each of these is one octet away from a permitted range. They exist so a
        // sloppy `a == 172` or `a == 100` check cannot pass this suite.
        listOf(
            "http://172.15.0.1:43210",
            "http://172.32.0.1:43210",
            "http://100.63.0.1:43210",
            "http://100.128.0.1:43210",
            "http://192.167.1.1:43210",
            "http://192.169.1.1:43210",
        ).forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }
}
