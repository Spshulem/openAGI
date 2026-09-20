package sh.openagi.mobile.protocol

import android.net.Uri

data class PairingPayload(val serverUrl: String, val code: String) {
    companion object {
        fun from(uri: Uri): PairingPayload? {
            if (uri.scheme != "openagi" || uri.host != "pair") return null
            val server = uri.getQueryParameter("url") ?: return null
            val code = uri.getQueryParameter("code") ?: return null
            if (code.length != 6 || !code.all { it.isDigit() }) return null
            return PairingPayload(server, code)
        }
    }
}
