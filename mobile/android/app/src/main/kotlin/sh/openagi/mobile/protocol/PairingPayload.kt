package sh.openagi.mobile.protocol

import android.net.Uri

data class PairingPayload(val serverUrl: String, val code: String) {
    companion object {
        fun from(uri: Uri): PairingPayload? =
            fromParts(scheme = uri.scheme, host = uri.host, queryParam = uri::getQueryParameter)

        // The actual parsing/validation logic, kept free of android.net.Uri so
        // it can run under a plain JUnit test. Uri itself is a framework stub
        // under unit tests (no Robolectric in this project) whose methods
        // return defaults rather than the fixture values a test would set up,
        // so PairingPayloadTest exercises this function directly with fake
        // scheme/host/query values instead.
        internal fun fromParts(scheme: String?, host: String?, queryParam: (String) -> String?): PairingPayload? {
            if (scheme != "openagi" || host != "pair") return null
            val server = queryParam("url") ?: return null
            val code = queryParam("code") ?: return null
            if (code.length != 6 || !code.all { it.isDigit() }) return null
            return PairingPayload(server, code)
        }

        // A pairing link that names the daemon this phone is already on is not
        // a switch -- there is nothing to disconnect. Asking anyway produces
        // "This phone is connected to X. Pairing with X disconnects it here",
        // a question with no meaningful answer, which is exactly what a
        // relaunch replaying an already-spent link put on screen.
        fun namesSameDaemon(current: String, incoming: String): Boolean =
            normalize(current) == normalize(incoming)

        private fun normalize(server: String): String = server.trim().trimEnd('/').lowercase()
    }
}
