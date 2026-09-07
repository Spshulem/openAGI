# G2 proactive build verification

Scope: `docs/g2-proactive-scope.md`. Depends on the talk settings/progress work
in PR #97. Client bundle version: 0.4.4. Main deployment is required first.

Verified: 35 focused server tests and 81 focused client tests passed. The new
server test passed twice, including HTTP authorization and revocation. The
assembled client typecheck passed, and the main page script parsed successfully.

Implemented: main-backed scoped inbox, source filters, quiet hours, interruption
limits, per-device dismiss/snooze, due user-task alerts, separate expiring
ambient retention consent, bounded final-text batching, evidence-backed explicit
commitment suggestions, idempotent user-task acceptance, retention/delete, and
an authenticated main handoff page. No background agent or model job was added.

Focused validation covers store lifecycle, cross-node authority, token-only G2,
non-G2/owner-token rejection, owner handoff, CORS, revocation, transient capture,
native foreground exit, consent-off, duplicate acceptance, upload failure without
replay and safe UI text rendering. Existing G2, outreach and data-dir tests also
run against isolated test state. No personal transcripts were inspected.

Limits: only existing outreach and due user tasks feed this inbox. No new email
or calendar connection is installed. Extraction uses explicit commitment phrases,
not broad semantic inference or verified speaker identification. 200 transcript
segments/device and 50 candidates bound storage and review load; capacity pauses
capture. A 60-second metadata-only timer expires records while main is running;
expired data is also removed at boot and before reads. No promise of deletion
from filesystem snapshots or provider retention. No OCU authority was expanded.

## Physical acceptance

1. Deploy matching main; open `/g2/proactive` with normal owner login. Install
   the G2 bundle without disconnecting; ensure pairing and talk preferences stay.
2. Enable inbox updates. Produce a harmless pending approval/due test task on
   main. Verify phone inbox and glasses idle delivery, swipe-up access from Home,
   pagination, snooze/dismiss and quiet-hour suppression. Check that no alert
   replaces a recording, in-progress answer, completed answer or sleeping screen.
3. With participants' consent, enable always-listening then memory. Say a harmless
   commitment. After 30 seconds refresh; compare retained text/evidence on main.
   Accept once, repeat acceptance and verify exactly one user task, no execution.
4. Pause listening, hide the phone app, and exit through the native G2 gesture.
   In each case verify memory turns off and no further segments are retained.
   Reopen: memory must require opt-in again. Repeat with live and buffered speech.
5. Delete memory. Refresh main/phone and verify transcript/suggestion removal;
   previously accepted user tasks remain. Test expiry with a shortened clock in
   automated tests, not by retaining a real conversation unnecessarily.

This work has not deployed to main, uploaded to Even Hub, installed on glasses,
or passed physical visual/gesture/battery verification.
