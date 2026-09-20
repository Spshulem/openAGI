package sh.openagi.mobile.store

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.security.GeneralSecurityException

// Credentials.load/save/clear all reach EncryptedSharedPreferences.create and
// MasterKey.Builder.build(), both declared `throws GeneralSecurityException,
// IOException` — Kotlin does not enforce checked exceptions, so nothing
// required either to be handled, and (per the whole-branch review) nothing
// did. A real Keystore isn't available under a plain JUnit test, so this
// exercises the exact seam those three methods route every Keystore call
// through: it must swallow any Exception and return the fallback rather than
// ever propagating, whether the failure is the security-crypto library's own
// checked exception type or some other RuntimeException an OEM Keystore
// implementation throws instead.
class CredentialsGuardTest {
    @Test
    fun aSuccessfulBlockReturnsItsValue() {
        assertEquals("ok", Credentials.guarded("fallback", "test") { "ok" })
    }

    @Test
    fun aGeneralSecurityExceptionFallsBackRatherThanThrowing() {
        assertEquals(null, Credentials.guarded<String?>(null, "test") { throw GeneralSecurityException("corrupt keyset") })
    }

    @Test
    fun anIOExceptionFallsBackRatherThanThrowing() {
        assertEquals(false, Credentials.guarded(false, "test") { throw IOException("disk full") })
    }

    @Test
    fun anUnexpectedRuntimeExceptionAlsoFallsBackRatherThanThrowing() {
        // OEM Keystore implementations are the most commonly reported source of
        // failures here, and they do not all throw the two checked types the
        // security-crypto library declares.
        assertEquals(Unit, Credentials.guarded(Unit, "test") { throw IllegalStateException("keystore not ready") })
    }
}
