package sh.openagi.mobile

import org.junit.Assert.assertTrue
import org.junit.Test

class LiveEventsTest {
    // A "No" or a dismiss from another client emits only clarification-resolved.
    // Missing it here left the answered question actionable in Inbox and its
    // badge counting it until the app resumed.
    @Test
    fun aResolvedClarificationRefreshesTheInboxAndItsBadge() {
        assertTrue("clarification-resolved" in REFRESH_TRIGGERING_EVENTS)
        assertTrue("clarification-resolved" in INBOX_AFFECTING_EVENTS)
    }
}
