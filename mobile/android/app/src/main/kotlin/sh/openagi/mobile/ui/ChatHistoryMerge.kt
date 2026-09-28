package sh.openagi.mobile.ui

import sh.openagi.mobile.protocol.ConversationMessage
import sh.openagi.mobile.protocol.ConversationPage

// Folds the daemon's newest page of a shared thread into what the phone is
// showing. The server is the history; the phone keeps only what the server
// cannot know yet:
//   - older cached lines, when they join onto the page with no gap
//   - its own send still in flight, or one that failed before the daemon
//     stored it (so "Try again" survives)
// A line this phone sent is recognised on the server as the first unclaimed
// user message from this node with the same text. Local ids are reused for
// lines already shown so the list does not jump.
internal object ChatHistoryMerge {
    fun merge(local: List<ChatEntry>, page: ConversationPage, ownNodeId: String, newId: () -> Long): List<ChatEntry> {
        val pageIds = page.messages.map { it.id }.toSet()
        val shownByServerId = local.mapNotNull { entry -> entry.serverId?.let { it to entry } }.toMap()

        val older = if (page.nextBefore == null || page.messages.isEmpty()) {
            emptyList()
        } else {
            val joinAt = local.indexOfFirst { it.serverId == page.messages.first().id }
            if (joinAt <= 0) emptyList() else local.subList(0, joinAt).filter { it.serverId != null && it.serverId !in pageIds }
        }

        val fromServer = page.messages.map { message -> toEntry(message, shownByServerId[message.id]?.id ?: newId(), ownNodeId) }

        val unclaimed = page.messages
            .filter { it.role == "user" && it.sourceNodeId == ownNodeId && it.id !in shownByServerId }
            .toMutableList()
        val unsynced = local.filter { it.serverId == null }
        val pending = mutableListOf<ChatEntry>()
        var index = 0
        while (index < unsynced.size) {
            val entry = unsynced[index]
            if (entry is ChatEntry.User) {
                val reply = unsynced.getOrNull(index + 1) as? ChatEntry.Assistant
                val match = unclaimed.firstOrNull { it.text == entry.text }
                if (match != null) unclaimed.remove(match)
                val replyUnfinished = reply == null || reply.streaming || reply.failed
                // Unconfirmed and unfinished: the daemon may never have seen it.
                // A finished pair the daemon does not have is an old cache line
                // from before shared threads, and the server copy wins.
                if (match == null && replyUnfinished) pending += entry
                if (reply != null && (reply.streaming || (reply.failed && match == null))) pending += reply
                index += if (reply != null) 2 else 1
            } else {
                if (entry is ChatEntry.Assistant && entry.streaming) pending += entry
                index += 1
            }
        }
        return older + fromServer + pending
    }

    private fun toEntry(message: ConversationMessage, id: Long, ownNodeId: String): ChatEntry =
        if (message.role == "user") {
            // Only another device is named; this phone's own lines need no label.
            val source = message.sourceName?.takeIf { message.sourceNodeId != null && message.sourceNodeId != ownNodeId }
            ChatEntry.User(id, message.at, message.text, serverId = message.id, sourceName = source)
        } else {
            ChatEntry.Assistant(id, message.at, message.text, streaming = false, serverId = message.id)
        }
}
