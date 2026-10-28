package sh.openagi.mobile.store

import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File

class WorkspaceIdentityTest {
    @get:Rule val folder = TemporaryFolder()
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

    @Test fun serverSwitchNeverDrainsAnotherServersOutbox() {
        val first = Credentials("https://first.example", "mobile:first", "fixture")
        val second = first.copy(server = "https://second.example")
        val a = Credentials.workspaceDirectory(folder.root, first)
        val phone = Credentials.workspaceDirectory(folder.root, first.copy(server = "http://127.0.0.1:43210"))
        OutboundQueue(a).enqueue(PendingOp.completeTask("only-on-first"))
        val b = Credentials.workspaceDirectory(folder.root, second)
        assertTrue(OutboundQueue(phone).all().isEmpty())
        assertTrue(OutboundQueue(b).all().isEmpty())
        assertEquals(1, OutboundQueue(Credentials.workspaceDirectory(folder.root, first)).all().size)
    }

    @Test fun legacyDataCanOnlyBeClaimedByItsOriginalSavedServer() {
        val first = Credentials("https://first.example", "mobile:first", "fixture")
        val second = first.copy(server = "https://second.example")
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("legacy-first"))
        Credentials.migrateLegacyDirectory(folder.root, first)
        val a = Credentials.workspaceDirectory(folder.root, first)
        assertEquals(1, OutboundQueue(a).all().size)
        assertFalse(File(folder.root, "outbox.json").exists())
        // A late old writer must not reassign that data to a new pairing.
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("late-first"))
        Credentials.migrateLegacyDirectory(folder.root, second)
        assertTrue(OutboundQueue(Credentials.workspaceDirectory(folder.root, second)).all().isEmpty())
        assertTrue(File(folder.root, "outbox.json").exists())
    }
}
