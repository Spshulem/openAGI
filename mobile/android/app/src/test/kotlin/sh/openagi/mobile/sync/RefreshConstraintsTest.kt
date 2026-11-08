package sh.openagi.mobile.sync

import androidx.work.NetworkType
import org.junit.Assert.assertEquals
import org.junit.Test
import sh.openagi.mobile.store.Credentials

class RefreshConstraintsTest {
    @Test fun phoneRefreshWorksWithoutWifiOrCellular() {
        assertEquals(NetworkType.NOT_REQUIRED, RefreshWorker.refreshConstraints(
            Credentials("http://127.0.0.1:43210", "mobile:fixture", "fixture")).requiredNetworkType)
    }

    @Test fun serverRefreshWaitsForANetwork() {
        assertEquals(NetworkType.CONNECTED, RefreshWorker.refreshConstraints(
            Credentials("https://agent.example", "mobile:fixture", "fixture")).requiredNetworkType)
    }
}
