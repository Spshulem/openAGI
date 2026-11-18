package sh.openagi.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// mobile/PROTOCOL.md §6: raisedAt is when the agent last asked for a card;
// mains older than the field omit it.
class PendingActionDecodingTest {
    @Test
    fun decodesRaisedAtWhenPresentAndToleratesItsAbsence() {
        val raw = """{"actions":[
            {"id":"a","toolName":"send_email","summary":"Email","status":"pending",
             "createdAt":"2026-11-17T10:00:00.000Z","raisedAt":"2026-11-17T10:10:00.000Z"},
            {"id":"b","toolName":"send_email","summary":"Email","status":"pending",
             "createdAt":"2026-11-17T10:00:00.000Z"}]}"""
        val actions = ProtocolJson.json.decodeFromString(PendingActionsResponse.serializer(), raw).actions
        assertEquals("2026-11-17T10:10:00Z", actions[0].raisedAt.toString())
        assertNull(actions[1].raisedAt)
    }
}
