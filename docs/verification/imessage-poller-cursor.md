# iMessage poll cursor continuity

The opt-in self-chat task poller must bootstrap only once. Its first enable
remains forward-only by default; configured backfill behavior is unchanged.
Previously, saving an imported batch replaced the checkpoint without its
initialization flag. The next poll bootstrapped again to the newest message,
silently skipping intervening messages or the remainder of a 200-message batch.

Cursor updates now preserve bootstrap metadata and explicitly retain initialized
state. Older checkpoints with a valid cursor and successful-sync timestamp resume
that cursor even if the initialization flag is absent. Explicit uninitialized
checkpoints still use first-enable behavior. No message scope, permissions,
authentication, automatic replies, or node trust behavior changes.

Focused synthetic SQLite fixtures cover consecutive polls, process recreation,
bounded batch draining, legacy checkpoint recovery, forward-only initialization,
and exclusion of other chats. Three regression cases fail on the original code.
The fixed batch test imports all 205 messages across two polls instead of 200.

This prevents future cursor skips; it cannot reconstruct messages already skipped
by a previous bootstrap. Source tests do not establish installation or live
message acceptance. Swift is unaffected.
