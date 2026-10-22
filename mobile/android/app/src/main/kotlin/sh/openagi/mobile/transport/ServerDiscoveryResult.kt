package sh.openagi.mobile.transport

data class DiscoveredServer(val address: String, val name: String, val reachable: Boolean? = null)

const val SERVER_DISCOVERY_HELP = "Look for a Mac or Distiller running the OpenAGI server. Sharing Wi-Fi with another phone doesn't connect or sync the two apps. If your iPhone is already connected, copy its server address from Settings and enter it here."
const val SERVER_DISCOVERY_NETWORK_HELP = "Wi-Fi discovery needs the server to announce itself on this network. Update and restart OpenAGI on the server if needed. Tailscale checks saved or entered addresses; it doesn't browse your whole tailnet."

fun serverDiscoveryNote(searching: Boolean, finished: Boolean, discoveryUnavailable: Boolean, servers: List<DiscoveredServer>): String? {
    if (searching) return "Looking for server announcements on Wi-Fi and checking your saved or entered address…"
    if (!finished) return null
    val result = when {
        servers.any { it.reachable == true } -> "Your server is responding. New phones need its one-time pairing code. Existing pairing stays saved; searching doesn't reconnect or switch servers."
        servers.isNotEmpty() -> "Server address found, but OpenAGI isn't responding from this phone. Keep the server running. For a Tailscale address, turn on Tailscale on both devices; for a LAN address, join the server's network."
        else -> "No OpenAGI server announced itself on this Wi-Fi. Keep OpenAGI running on your Mac or Distiller with local discovery enabled, or enter the server address shown on your connected iPhone."
    }
    return if (discoveryUnavailable) "$result Wi-Fi discovery couldn't start; check the phone's network permissions. Saved or entered addresses can still be checked." else result
}
