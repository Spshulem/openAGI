package sh.openagi.mobile.embedded

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.transport.DaemonClient

@RunWith(AndroidJUnit4::class)
class EmbeddedCredentialTest {
    @Test fun reenteringPhoneAfterRevocationRenewsCachedCredentials(): Unit = runBlocking {
        assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("Emulator"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val previous = Credentials.load(context)
        try {
            val original = EmbeddedAgent.start(context, activate = false)
            DaemonClient(original.server, original.nodeId, original.token).revoke()
            val renewed = EmbeddedAgent.start(context, activate = false)
            assertNotEquals(original.nodeId, renewed.nodeId)
            DaemonClient(renewed.server, renewed.nodeId, renewed.token).tasks()
            assertEquals("Starting in the background preserves the selected workspace", previous, Credentials.load(context))
        } finally {
            if (previous != null) Credentials.save(context, previous) else Credentials.clear(context)
        }
    }
}
