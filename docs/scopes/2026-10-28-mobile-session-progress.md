# Native mobile session progress

## Outcome and v1 scope

A paired phone can tell how many supervised coding sessions are working,
blocked, waiting on a dependency, or need the owner's answer, and open the
exact relevant session. One overview covers the fleet, with needs-you first,
then blocked, working, and waiting. Counts are unique sessions, not questions;
quiet, excluded, and supervisor-nudge queues are not called running.

- iOS: native ActivityKit/SwiftUI Lock Screen and Dynamic Island presentation,
  Review/Open session links, a Sessions link, and a native Review agent
  sessions App Shortcut. Existing authenticated question answer buttons stay
  available in notifications. No lock-screen action silently approves work.
- Android: native ongoing notification with the same counts and the first
  session's blocker, Review/Open sessions, and Stop monitoring. Settings →
  Pin session progress explicitly requests Live Update promotion on Android
  16+ while sessions are active and fresh. The OS/OEM controls promotion;
  a standard ongoing card remains the fallback. Swiping it away stops
  monitoring rather than repeatedly reposting a promoted card.
- Freshness: show the source scan time, not just push delivery time. After
  30 minutes without a scan, show paused/last-known information; Android also
  marks failed connection checks. A newer scan refreshes the iOS stale
  deadline even when the session counts did not change. Partial source
  failures are visible. Android's age label updates locally without polling
  more often; the existing 5-minute network fallback remains.
- Privacy: iOS activity data stays inside the existing encrypted envelope.
  Android hides session names on private lock screens. Links contain only
  session identity and select a screen; they never execute agent commands.
- Lifecycle: existing iOS idle end/retry/token-rotation behavior is retained;
  Android service/notification permission and its Settings switch remain
  authoritative. A removed session leads to the overview, not another chat.

## Boundaries

This extends the existing paired Supervisor. It does not make phone-only
agents run indefinitely in the background, change server discovery/pairing,
add an Android push relay, or change provider permissions. iOS background
updates still require working APNs signing and the configured push relay.
Android promotion requires an eligible device and system/user permission.

## Verification

Automated: daemon projection and encrypted push lifecycle regressions; iOS
legacy payload decoding, scan freshness, reserved-character session links,
and cold-launch routing; Android count projection, priority, stale/offline
and reconnect behavior; existing mobile unit/UI/build/lint lanes.

Physical acceptance (separate from CI):

1. Pair both phones to a current daemon and allow notifications. Start a
   working session, a blocked session, and one with an open owner question.
   Compare counts with Supervisor; open Review from the lock screen.
2. iOS: expand Dynamic Island; open an individual row, Sessions, and the
   Review agent sessions Shortcut. Repeat after force-closing the app and
   after removing the target session. Check large text and system appearance.
3. Android: enable Pin session progress, check promoted and ordinary forms,
   fold/unfold, open Review, and stop/dismiss monitoring. Confirm it stays
   stopped until enabled again and question notifications remain readable.
4. Disconnect the server, let source data age, then reconnect. Old counts
   must be labelled last-known/paused, never a live success indicator.
5. Lock the phone with private notifications hidden; verify session names
   and blocker text are concealed. Revoke pairing and verify cleanup.

A source/test pass does not establish APNs delivery, OEM promotion, physical
lock-screen behavior, or installation on either phone.
