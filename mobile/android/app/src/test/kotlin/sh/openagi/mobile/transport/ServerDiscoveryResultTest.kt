package sh.openagi.mobile.transport

import org.junit.Assert.*
import org.junit.Test

class ServerDiscoveryResultTest {
    @Test fun savedUnreachableServerIsNotReportedAsNoServersFound() {
        val note = serverDiscoveryNote(false, true, false, listOf(DiscoveredServer("http://main.tail1234.ts.net:43210", "Saved", false)))!!
        assertTrue(note.contains("address found"))
        assertTrue(note.contains("Tailscale on both devices"))
        assertFalse(note.contains("No OpenAGI server announced"))
    }
    @Test fun emptyWifiSearchExplainsServerAndConnectedPhoneAddress() {
        val note = serverDiscoveryNote(false, true, false, emptyList())!!
        assertTrue(note.contains("announced itself"))
        assertTrue(note.contains("Mac or Distiller"))
        assertTrue(note.contains("connected iPhone"))
    }
    @Test fun permissionFailureSurvivesSearchCompletion() {
        assertTrue(serverDiscoveryNote(false, true, true, emptyList())!!.contains("network permissions"))
    }
    @Test fun reachableSavedServerIsUsefulEvenWhenWifiDiscoveryFails() {
        val note = serverDiscoveryNote(false, true, true, listOf(DiscoveredServer("https://main.example.com", "Saved", true)))!!
        assertTrue(note.contains("server is responding"))
        assertTrue(note.contains("Wi-Fi discovery couldn't start"))
    }
    @Test fun searchDoesNotAnnounceResultsBeforeItCompletes() {
        assertNull(serverDiscoveryNote(false, false, false, emptyList()))
        assertTrue(serverDiscoveryNote(true, false, false, emptyList())!!.startsWith("Looking for"))
    }
}
