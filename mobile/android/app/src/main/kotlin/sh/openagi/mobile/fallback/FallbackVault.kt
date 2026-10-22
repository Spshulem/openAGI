package sh.openagi.mobile.fallback

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.MessageDigest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

// Device Keystore encrypts both API keys and this separate chat. Backup is
// disabled by the app manifest. No secrets in intents, saved state or logs.
class FallbackVault(context: Context) {
    private val store = EncryptedSharedPreferences.create(context, "sh.openagi.direct-provider",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)

    fun key(provider: FallbackProvider): String? = store.getString("key.${provider.name}", null)
    fun saveKey(provider: FallbackProvider, raw: String) {
        val key = raw.trim()
        if (key.isEmpty() || key.any { it == '\n' || it == '\r' }) throw FallbackException("Enter a valid API key.")
        if (!store.edit().putString("key.${provider.name}", key).commit()) throw FallbackException("Couldn't save the key securely on this phone.")
    }
    fun removeKey(provider: FallbackProvider) { if (!store.edit().remove("key.${provider.name}").commit()) throw FallbackException("Couldn't remove the saved key.") }
    fun model(provider: FallbackProvider) = store.getString("model.${provider.name}", null) ?: provider.defaultModel
    fun saveModel(provider: FallbackProvider, model: String) {
        if (!store.edit().putString("model.${provider.name}", model).commit()) throw FallbackException("Couldn't save Chat options.")
    }
    private fun historyKey(provider: FallbackProvider, model: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("${provider.name}:$model".toByteArray()).joinToString("") { "%02x".format(it) }
        return "history.$digest"
    }
    fun history(provider: FallbackProvider, model: String): List<FallbackLine> {
        val text = store.getString(historyKey(provider, model), null) ?: return emptyList()
        return Json.decodeFromString(text)
    }
    fun saveHistory(provider: FallbackProvider, model: String, lines: List<FallbackLine>) {
        if (!store.edit().putString(historyKey(provider, model), Json.encodeToString(lines.takeLast(200))).commit()) throw FallbackException("Couldn't save this conversation on the phone.")
    }
}
