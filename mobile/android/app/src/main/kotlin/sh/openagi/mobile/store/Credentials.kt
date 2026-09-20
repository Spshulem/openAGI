package sh.openagi.mobile.store

import android.content.Context
import android.util.Log
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
        private const val TAG = "Credentials"

        // EncryptedSharedPreferences.create and MasterKey.Builder.build() both
        // declare `throws GeneralSecurityException, IOException` — Kotlin does
        // not enforce that, so nothing forced these to be handled, and nothing
        // was. Keystore key invalidation (a biometric/lock-screen change), a
        // corrupt keyset, or an OEM device-clone are the most commonly reported
        // failure modes for this exact class. Two of the unguarded call sites
        // were the widget's provideGlance and MainActivity.onCreate — the app
        // could not launch at all on an affected device. iOS's Keychain load
        // returns nil on any failure and its clear ignores the status; this is
        // the same posture, made explicit rather than accidental. Every
        // Keystore-touching call below goes through `guarded`/`guardedOrThrow`
        // instead of a bare try/catch so the swallowing behaviour itself is one
        // small seam that CredentialsGuardTest can exercise without a real
        // Keystore.
        private fun prefs(context: Context): EncryptedSharedPreferences? = guarded(null, "store unavailable") {
            EncryptedSharedPreferences.create(
                context,
                FILE,
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ) as EncryptedSharedPreferences
        }

        fun load(context: Context): Credentials? {
            val store = prefs(context) ?: return null
            return guarded(null, "read failed") {
                val server = store.getString("server", null) ?: return@guarded null
                val nodeId = store.getString("nodeId", null) ?: return@guarded null
                val token = store.getString("token", null) ?: return@guarded null
                Credentials(server, nodeId, token)
            }
        }

        // Returns whether the credential was actually persisted. A caller that
        // ignores this return value (there should be none) would otherwise
        // believe pairing succeeded when the device's Keystore silently
        // refused to write it.
        fun save(context: Context, credentials: Credentials): Boolean {
            val store = prefs(context) ?: return false
            return guarded(false, "write failed") {
                store.edit()
                    .putString("server", credentials.server)
                    .putString("nodeId", credentials.nodeId)
                    .putString("token", credentials.token)
                    .commit()
            }
        }

        fun clear(context: Context) {
            guarded(Unit, "clear failed") {
                prefs(context)?.edit()?.clear()?.commit()
                Unit
            }
        }

        // The seam: run a Keystore-touching block, and on any failure log a
        // class name (never a token, never a stack trace that could carry one
        // through a crash-reporting pipeline) and return the given fallback
        // instead of propagating. `CredentialsGuardTest` exercises this exact
        // function with a throwing block to pin "never throws, always falls
        // back" without needing a real Android Keystore.
        internal fun <T> guarded(fallback: T, what: String, block: () -> T): T = try {
            block()
        } catch (error: Exception) {
            Log.w(TAG, "credential $what: ${error.javaClass.simpleName}")
            fallback
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
