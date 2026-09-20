package sh.openagi.mobile.store

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

// The node token is the whole security boundary of this app. It lives in
// EncryptedSharedPreferences under a Keystore-held master key, never in the
// snapshot file, and never in logs.
data class Credentials(val server: String, val nodeId: String, val token: String) {
    // A data class prints every property, so the generated toString() would put
    // the token into any log line, crash report or debugger frame that touched
    // a Credentials. "Never logged" should be a property of the type, not of
    // everyone who handles it remembering.
    override fun toString(): String = "Credentials(server=$server, nodeId=$nodeId, token=<redacted>)"

    companion object {
        private const val FILE = "sh.openagi.mobile.credentials"

        private fun prefs(context: Context) = EncryptedSharedPreferences.create(
            context,
            FILE,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

        fun load(context: Context): Credentials? {
            val store = prefs(context)
            val server = store.getString("server", null) ?: return null
            val nodeId = store.getString("nodeId", null) ?: return null
            val token = store.getString("token", null) ?: return null
            return Credentials(server, nodeId, token)
        }

        fun save(context: Context, credentials: Credentials) {
            prefs(context).edit()
                .putString("server", credentials.server)
                .putString("nodeId", credentials.nodeId)
                .putString("token", credentials.token)
                .apply()
        }

        fun clear(context: Context) {
            prefs(context).edit().clear().apply()
        }
    }
}

// Context-free by construction: node identity generation has no Android
// dependency, unlike Credentials.load/save/clear above (which need a real
// Keystore-backed EncryptedSharedPreferences and cannot run on the JVM). That
// is what keeps this half of the file unit-testable.
object MobileNodeIdentity {
    fun newNodeId(): String = "mobile:" + UUID.randomUUID().toString()

    // 32 random bytes, base64url, unpadded — 43 characters, matching the token
    // shape the daemon's NodeRegistry issues and hashes.
    fun newToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
