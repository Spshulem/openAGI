# G2 minimal listening, lifelog and actionable inbox

Status: implemented for the 0.4.7 candidate in PR #100; physical verification
and main deployment remain pending. See the separate
[implementation record](verification/2026-09-07-minimal-lifelog-ux.md) for tested
capabilities, delivery constraints and the device acceptance checklist.

## User evidence and assumptions

Direct user feedback on 2026-09-07 is the source of this scope:

- U1: “I don't want to see text all day long but I want to keep it on listening.”
- U2: “I don't see my life logs anywhere”; the task list is too large to scroll past.
- U3: “When I swipe up I only get one out of 80”; browsing requires repeated taps.
- U4: Mark tasks complete, including “this one's done,” and synchronize with main.
- U5: “Remind me to file my taxes tomorrow,” plus a way to highlight a moment.
- U6: Briefly acknowledge identified actions or follow-ups while listening,
  then return to the minimal listening view without taking over an active answer.

This is OpenAGI product feedback, not a BuildBetter customer research task. No
BuildBetter evidence was collected. The shared spec template is unavailable;
this document uses the specification skill's standard sections. Assumptions:
retain tap-to-talk as the default the user already likes; avoid overloading the
same gesture with talking and highlighting; keep current recording consent,
retention, foreground limits, owner permissions and analysis budget controls.

## User scenarios and acceptance

### 1. Wear glasses without reading instructions all day (P1; U1)

With lifelog active and the microphone actually receiving audio, idle glasses
show only `Listening` with a subtle activity indicator. No gesture legend,
retention paragraph, task count or foreground disclaimer occupies idle view.
Those details remain accessible in phone controls/contextual help. When lifelog
is off, the normal ask/options screen is appropriate. When capture fails or
pauses, visibly show that state; never continue claiming to be listening.

Tap starts the manual talk/stop/send-or-review flow. After finishing, preserve
the answer until the user goes Back; Back returns to minimal listening without
stopping capture. Double-tap while idle listening pauses microphone and
retention, with a brief acknowledgement. Resume follows current session-consent
rules and never silently grants new retention consent.

### 2. Find transcripts, not just recent agent answers (P1; U2)

Phone navigation exposes Listen, Lifelog, Inbox and Recent answers as peer
destinations. Lifelog is reachable in one action from the initial screen,
without scrolling through tasks or opening an owner-token sign-in page.
Show chronological conversations with time, brief title, saved transcript and
available speaker labels; provide search and bounded pagination.

Differentiate live transcription, text waiting to save and text confirmed saved
on main. Show last successful save and a clear retry/error/empty state. A new
user must not mistake an empty history for a disabled microphone. Recent
answers remain distinct from retained ambient conversations.

Inbox has its own bounded scroll area or dedicated screen; expanding 80 items
must not push listening controls or lifelog below a giant page. Details are
collapsed initially. Phone touch scrolling, focus and Back must remain usable.

### 3. Browse and act on the inbox from glasses (P1; U3, U4)

Swipe up from idle opens Inbox. In the inbox list, each up/down swipe moves to
the adjacent item; tapping opens the selected item's details/actions rather
than advancing to another item. In details, swipes read long content;
double-tap returns to the list, preserving selection. List boundaries and
empty/end states are explicit, without endless wrapping or trapping the user.

Available actions depend on the item: read details, dismiss an alert, snooze,
review a proposed reminder/task, complete a real task, or ask about this item.
Completion and dismissal must be separate and accurately labeled. Do not offer
Complete for an alert that has no writable underlying task.

Explicit speech such as “mark this one done” uses the item selected when Talk
began, even if new alerts arrive. Before changing state, show the exact task
title and confirmation. Ambiguous targets/dates or stale/removed tasks require
clarification instead of guessing. Distinguish “saved on main” from confirmed
completion in an external source; unsupported source writes say so clearly.

### 4. Turn overheard commitments into proposals (P1; U5)

During consented lifelog capture, phrases including “remind me to file my taxes
tomorrow” become evidence-linked reminder candidates, not silent executions.
Resolve relative dates using the user's timezone and show the interpreted date;
if a reminder needs a delivery time, ask for it rather than inventing one.
Unverified speakers do not become the owner merely by saying “me.”

An eligible proposal may briefly interrupt idle listening with a compact
“Reminder suggested” card, subject to notification opt-in, quiet hours, dedup
and interruption limits. Do not stream every transcript or analysis operation
onto the glasses. Confirming creates the canonical task/reminder on main and
shows acknowledgement only after main confirms. Transcript capture alone does
not imply semantic analysis or scheduling is enabled. Preserve explicit
analysis opt-in, bounded costs, and no repeated model work for unchanged text.

### 5. Highlight a moment without losing talk controls (P2; U5)

Provide an explicit Mark moment action on the phone and in contextual glasses
controls. It bookmarks the current time and links available retained context;
it does not invent missing audio or record without consent. Allow optional
single-tap-to-highlight as a clearly labeled gesture preference, not the default.
When enabled, make Talk available through the contextual control path. Do not
assign one tap both actions, or add a delay to every normal tap-to-talk gesture.

Do not depend on hold/release gestures: current verified controls lack reliable
press/release events. A hold shortcut is conditional on future device support
and physical verification, with an equivalent accessible tap/voice action.

## Functional requirements

- F1: Minimal idle display and truthful recording/paused/error state (scenario 1).
- F2: Context-specific, nonconflicting talk, pause, list and detail gestures (1, 3, 5).
- F3: One-action paired lifelog access, save receipts and separate bounded lists (2).
- F4: Swipe through every available inbox item without tapping to advance (3).
- F5: Target-bound confirmed task actions and explicit source-write capability (3).
- F6: Reminder proposals cite transcript evidence and require confirmed dates/time (4).
- F7: Canonical main-owned tasks/reminders/bookmarks; no false success while offline (3–5).
- F8: Highlights respect recording consent and cascade on transcript deletion/expiry (5).
- F9: Current permissions, retention, analysis opt-in, budget and alert controls persist (all).

## Key entities and synchronization

Conversation/moment, transcript segment, bookmark, reminder candidate, canonical
task/reminder, inbox alert and action receipt are distinct entities. Dismissing
an alert is not completing a task. Completing a task is not deleting its source
conversation. Mutations must be scoped to authorized targets, tolerate retries
without duplication, and reflect main's latest state across phone and glasses.
Do not broaden the paired G2's permissions into owner-wide access. Confirmed
tasks follow their own lifecycle; transcript-derived highlights/proposals follow
the transcript's deletion and retention rules.

## Success criteria and release gates

- In a 10-minute consented idle listening test, glasses show no standing text
  beyond Listening and its indicator, except genuine errors or opted-in alerts.
- From launch, reach saved lifelog in one action without passing through tasks
  or entering a second token. Verify saved text against main, not recent answers.
- Browse all 80 fixture inbox items using only swipes in list mode; open details,
  return to the same selection, and complete one eligible task with confirmation.
- An arrival during “this one's done” never changes the action's target. Repeating
  confirmation after a connection loss never creates a duplicate task/reminder.
- The tax-reminder example produces a proposal with evidence and interpreted
  date; it is not reported scheduled before required time/confirmation/main receipt.
- Test mark-moment, pause, consent withdrawal, foreground exit, deletion and
  app restart. No implied background recording or resurrected expired history.
- Automated state/permission/synchronization tests plus physical glasses and
  phone gesture/layout acceptance are required before one coherent new build.

## Dependencies and exclusions

Minimal display, navigation and history discoverability are client UX work.
Canonical task completion from G2, durable bookmarks and confirmed reminder
scheduling may require main-side scoped operations; unlike 0.4.6, do not promise
that the complete follow-on scope needs no server update. Verify existing task
and scheduler capabilities before implementation. No new model selection, paid
analysis activation, owner-authentication bypass, or unsupported all-day
background capture is authorized by this scope document.
