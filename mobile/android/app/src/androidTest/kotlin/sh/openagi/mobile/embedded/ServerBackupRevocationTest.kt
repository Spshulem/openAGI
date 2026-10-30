package sh.openagi.mobile.embedded

import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.sync.forgetPairing

@RunWith(AndroidJUnit4::class)
class ServerBackupRevocationTest {
    @Test fun offlineRevocationForgetsOnlyTheMatchingServerBackup(): Unit = runBlocking {
        assumeTrue(Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("Emulator") ||
            Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish")
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val namespace = "server-backup-test-${UUID.randomUUID()}"
        val context = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int) =
                super.getSharedPreferences("$name.$namespace", mode)
            override fun getFilesDir() = File(base.cacheDir, namespace).apply { mkdirs() }
        }
        val prefs = EncryptedSharedPreferences.create(context, "sh.openagi.embedded-agent",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
        // No daemon listens on this port. Revocation must still erase both
        // credential copies, without contacting any real server or account.
        val server = Credentials("https://127.0.0.1:1", "mobile:backup-fixture", "synthetic-server-token")
        try {
            assertTrue(prefs.edit().putString("server", server.server).putString("serverNode", server.nodeId)
                .putString("serverToken", server.token).putString("owner", "synthetic-phone-owner").commit())
            val other = server.copy(nodeId = "mobile:other-fixture")
            assertTrue(Credentials.save(context, other))
            forgetPairing(context, other)
            assertEquals("Forgetting another pairing preserves the saved server", server, EmbeddedAgent.serverBackup(context))

            val matching = server.copy(server = server.server + "/", token = "synthetic-rotated-token")
            assertTrue(Credentials.save(context, matching))
            forgetPairing(context, matching)
            assertNull("The revoked server cannot be restored after switching modes", EmbeddedAgent.serverBackup(context))
            assertNull("The active pairing is also forgotten", Credentials.load(context))
            assertEquals("synthetic-phone-owner", prefs.getString("owner", null))
        } finally {
            base.deleteSharedPreferences("sh.openagi.embedded-agent.$namespace")
            base.deleteSharedPreferences("sh.openagi.mobile.credentials.$namespace")
            context.filesDir.deleteRecursively()
        }
    }
}
