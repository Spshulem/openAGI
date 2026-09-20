package sh.openagi.mobile.ui

// DESIGN.md's Chat section: "Consecutive messages from the same speaker
// tighten to 2pt apart; a change of speaker opens to 12. No timestamp
// unless more than 15 minutes passed, and then it is a centred caption in
// muted between the two groups." Pure (no Compose types) so the rule is
// trivially unit-testable; ChatScreen supplies the previous/current message's
// speaker and epoch-second timestamp per list item.
object MessageGrouping {
    const val TIGHT_SPACING_DP = 2
    const val GROUP_SPACING_DP = 12
    private const val TIMESTAMP_GAP_SECONDS = 15 * 60

    // True once more than 15 minutes separates two consecutive messages,
    // regardless of who sent either one — the divider marks a gap in time,
    // not a change of speaker.
    fun needsTimestampDivider(previousEpochSeconds: Long?, currentEpochSeconds: Long): Boolean {
        if (previousEpochSeconds == null) return false
        return currentEpochSeconds - previousEpochSeconds > TIMESTAMP_GAP_SECONDS
    }

    // The vertical gap, in dp, to place above `current`. A timestamp divider
    // already carries its own visual break, so a message right after one
    // always opens at the wider group spacing rather than also tightening to
    // a same-speaker run that happens to span the gap.
    fun spacingBeforeDp(previousIsUser: Boolean?, previousEpochSeconds: Long?, currentIsUser: Boolean, currentEpochSeconds: Long): Int {
        if (previousIsUser == null) return 0
        if (needsTimestampDivider(previousEpochSeconds, currentEpochSeconds)) return GROUP_SPACING_DP
        return if (previousIsUser == currentIsUser) TIGHT_SPACING_DP else GROUP_SPACING_DP
    }
}
