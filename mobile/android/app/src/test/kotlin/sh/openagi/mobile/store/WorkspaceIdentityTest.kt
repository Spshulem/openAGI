package sh.openagi.mobile.store

import org.junit.Assert.*
import org.junit.Test

class WorkspaceIdentityTest {
    @Test fun localPortChangesKeepTheWorkspaceButAReenrolledNodeDoesNot() {
        val local = Credentials("http://127.0.0.1:43210", "mobile:first", "fixture")
        assertEquals(local.workspaceId, local.copy(server = "http://127.0.0.1:43211").workspaceId)
        assertNotEquals(local.workspaceId, local.copy(nodeId = "mobile:replacement").workspaceId)
    }

    @Test fun serverActionsCannotBelongToPhoneOrAnotherServer() {
        val server = Credentials("https://first.example", "mobile:first", "fixture")
        assertNotEquals(server.workspaceId, server.copy(server = "http://127.0.0.1:43210").workspaceId)
        assertNotEquals(server.workspaceId, server.copy(server = "https://second.example").workspaceId)
        assertEquals(server.workspaceId, server.copy(token = "rotated-fixture").workspaceId)
        assertFalse(server.workspaceId.contains(server.nodeId))
    }
}
