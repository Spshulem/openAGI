# G2 0.4.7 minimal lifelog UX candidate

## Delivered code

- Consented quiet lifelog idle shows only `Listening` and changing dots.
- Eligible notices show Action identified / Reminder suggested / Follow-up
  suggested / Update from main for 4.5 seconds, then return to idle. Notification
  opt-in, quiet hours, dedup and hourly cap remain authoritative. No notices steal
  a manual question, answer, inbox, sleeping display or hidden app.
- Tap talks by default. Double-tap idle pauses. Swipe up opens inbox; subsequent
  up/down swipes select adjacent items with fixed boundaries. Tap opens details,
  then actions; double-tap backs through those levels. Arrivals do not retarget
  an item already being browsed. Reopen the inbox for a fresh list.
- Task completion confirms exact title/id/due date against current main state.
  Dismiss and snooze affect alerts only. A selected-task voice request such as
  “this one's done” is transcribed before mutation even with auto-send enabled,
  freezes the target at Talk, and requires glasses confirmation. Other phrases
  go to the agent with the selected item as reference, not mutation authority.
- Phone Listen / Lifelog / Inbox / Recent are peer destinations. Lifelog uses
  paired auth with search/pagination. Inbox details start collapsed; lists have
  bounded scrolling. Listen distinguishes queued final text from saved receipts.
- Mark moment is on phone and in swipe-down listening controls. Optional saved
  tap-to-highlight preference leaves Talk available in those controls. Marks
  link the latest saved segment from the current consent, at most 60 seconds old;
  before the first saved words, marking reports an error. Marks expire/delete
  with their evidence. Repeated marks on one segment reuse the same mark.
- “Remind me to…” creates an unverified-speaker proposal with evidence. Today /
  tomorrow date hints use the main's configured timezone. Phone confirmation
  explicitly chooses a future date/time and displays the resolved local date.
  Acceptance creates one canonical user task with a due date, even on retries.

## Boundaries and rollout

This is a candidate, not physical-device acceptance. Main must receive this PR's
backend changes before testing completion, marks or reminder proposals. No
main/node deployment or glasses installation is implied by the bundle build.

Reminder delivery uses the existing due-task inbox, not a new cron job or a
guaranteed alarm. It requires notifications and Tasks enabled, a foreground app,
and is subject to quiet hours and rate limits. Date/time confirmation is currently
phone-based; hold/release gestures are not supported by the current SDK. Completed
tasks sync to OpenAGI main, not to external task/calendar providers.

Capture still batches finalized text (initially about 30 seconds). Inbox reads
occur on a 60-second cadence and after a successful save. A notice waits for idle
eligibility (including 15 seconds since ambient speech); it is not word-by-word
intent streaming. These operations add no model calls or recurring model work.

## Verification

Client: 96 tests across 16 files pass; TypeScript passes. Main: 31 focused
lifelog/proactive/data-directory/boot tests pass. Regression fixtures cover all 80 inbox entries, stable voice
targets, confirmation, transient notice return, safe DOM text, bounded lists,
timezone date hints, idempotent main actions, consent and retention cascades.

Physical checks still required after main update and bundle installation:

1. Keep consented quiet lifelog open for 10 minutes. Only Listening should remain
   on idle glasses; leaving the app or double-tapping must stop capture.
2. Enable Discoveries notifications outside quiet hours. Say “remind me to file
   my taxes tomorrow.” After save/idle eligibility, verify a brief suggestion,
   then Listening again. Confirm a date/time on phone and verify the main task.
3. Browse several tasks by swiping, tap details/actions, double-tap back. Complete
   a disposable test task with confirmation and verify its state on main.
4. Ask “this one's done” with a task selected; verify the confirmation names that
   task. Cancel once, then confirm. No mutation should occur before confirmation.
5. Mark a moment after saved text appears, open Lifelog without another token,
   and verify the mark/transcript on main. Check phone list scrolling and spacing.
6. Ask a normal question while listening; the answer must stay until Back, with
   capture resuming and Back returning to the minimal idle view.
