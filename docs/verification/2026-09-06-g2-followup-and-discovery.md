# G2 follow-up and desktop session discovery

## Changes

- A tap on a completed answer starts recording a follow-up using the selected
  conversation ID. The previous answer remains in persisted Recent history.
  Swipes still page; double-tap goes back without triggering a pending tap.
- The answer footer now advertises `Tap: follow up`. Client package version is
  0.4.2, with no pairing or origin-specific credential changes.
- Desktop discovery validates entries individually. Invalid records are skipped;
  every copy of an ambiguous provider/session ID is excluded, even when only one
  copy has a valid fingerprint. Independently valid targets remain visible.
- Partial discovery has an explicit warning. Limits remain 100 discovered
  recent entries in the adapter's 24-hour window and 200 combined node entries;
  this is not an unlimited inventory of all historical chats.

## Live verification

The read-only adapter initially reported 81 recent entries (55 Codex, 26 Claude),
including one invalid ID and one ambiguous ID. The previous all-or-nothing
validation suppressed all desktop entries, leaving only managed test sessions.

After installing the fix on the idle Mac node and main, the authenticated main
list returned HTTP 200 with 78 entries: 52 Codex and 26 Claude. Of these, 76 were
read-only desktop entries, plus two reply-capable managed tests. A Claude desktop
session inspection returned three turns; the first inspected Codex entry returned
no visible turns. No existing chat received a reply, and no write permission was
broadened. Listing/read access is distinct from safe delivery into an owning app.

23 focused supervisor/adapter tests and 65 client tests across 14 files passed.
The isolated remote client build passed `tsc --noEmit`, Vite packaging, and the
packaged secret scan. Version 0.4.2 was packaged with no personal origin arguments
and downloaded to `/Users/shooby/Downloads/agents-0.4.2.ehpk` (68,569 bytes).
Physical glasses installation and gesture acceptance remain unverified; the
bundle has not been uploaded or installed. These changes are not committed or
pushed in this turn.
