package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// DESIGN.md's Chat section: "Consecutive messages from the same speaker
// tighten to 2pt apart; a change of speaker opens to 12. No timestamp unless
// more than 15 minutes passed, and then it is a centred caption in muted
// between the two groups."
class MessageGroupingTest {
    @Test
    fun theFirstMessageInAConversationGetsNoTopSpacing() {
        assertEquals(0, MessageGrouping.spacingBeforeDp(null, null, currentIsUser = true, currentEpochSeconds = 1_000))
    }

    @Test
    fun sameSpeakerBackToBackTightensTo2Dp() {
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = true,
            previousEpochSeconds = 1_000,
            currentIsUser = true,
            currentEpochSeconds = 1_010,
        )
        assertEquals(2, spacing)
    }

    @Test
    fun aChangeOfSpeakerOpensTo12Dp() {
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = true,
            previousEpochSeconds = 1_000,
            currentIsUser = false,
            currentEpochSeconds = 1_010,
        )
        assertEquals(12, spacing)
    }

    @Test
    fun noDividerBeforeFifteenMinutesHavePassed() {
        val fourteenMinutesLater = 1_000L + 14 * 60
        assertFalse(MessageGrouping.needsTimestampDivider(1_000, fourteenMinutesLater))
    }

    @Test
    fun aDividerAppearsOnceMoreThanFifteenMinutesHavePassed() {
        val sixteenMinutesLater = 1_000L + 16 * 60
        assertTrue(MessageGrouping.needsTimestampDivider(1_000, sixteenMinutesLater))
    }

    @Test
    fun aTimestampGapOpensToGroupSpacingEvenForTheSameSpeaker() {
        // A long pause from the same speaker still isn't a "tight" follow-up
        // — the divider already marks the break, so the message under it
        // opens at the wider spacing rather than tightening.
        val sixteenMinutesLater = 1_000L + 16 * 60
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = true,
            previousEpochSeconds = 1_000,
            currentIsUser = true,
            currentEpochSeconds = sixteenMinutesLater,
        )
        assertEquals(12, spacing)
    }

    @Test
    fun aMissingPreviousTimestampNeverNeedsADivider() {
        assertFalse(MessageGrouping.needsTimestampDivider(null, 1_000))
    }
}
