# G2 0.4.3: transcript review and activity

Manual voice sends on Stop by default. A persisted auto-send setting can be
disabled to require explicit Send for both buffered and live speech; discard and re-record leave saved answers
and conversation identity intact. Wake listening remains explicitly opt-in
and automatic. Drafts are transient and are not restored after app exit.

The glasses show Thinking and a bounded, timestamped tool/stage history.
Tap toggles partial text/activity, swipes browse, and double-tap asks whether
to stop. Only confirming that prompt cancels. No private reasoning, raw tool
arguments or tool results are displayed. Existing backend streaming is reused.

SDK 0.0.13 exposes click, double-click and scroll, not press/release; true
hold-to-talk is unsupported. This patch does not invent a long-press gesture.

## Verification

- 75 focused client tests passed; assembled-client TypeScript check passed.
- Auto-send defaults on for older pairings. An explicit confirmation preference
  persists through reopen/disconnect and cannot change during an active question.
  Buffered auto-send uses one ask request; live auto-send waits for finalized
  text and sends exactly once. Deepgram interim text remains visible while recording.
- Coverage includes no send before confirmation, duplicate Send, draft discard,
  re-record, conversation identity, cancelled/late transcription, streamed tool
  activity, stable partial answer paging and two-step glasses cancellation.
- Client overlay tested in an isolated copy of the G2 base at
  `899b7ba89015039622f5e0f7b6a22106d442d24e`, plus its separately present
  `src/buildbetter` dependencies. The overlay is not a standalone app checkout.
- Live main diagnosis found a legacy explicit HTTP computer-node override
  taking precedence over authenticated paired-node routing. Removed only that
  override after verifying zero active desktop sessions; retained a private
  configuration backup and restarted the service. No insecure transport bypass
  was enabled. Health returned 200 and computer-use readiness became
  `control-ready`, with no new desktop actions. The Mac Mini reported locked;
  the MacBook reported ready. This is readiness evidence, not a physical action
  test or a claim that the upstream engine is now the production default.

## Physical acceptance still required

1. Install the new bundle without disconnecting; verify pairing survives reopen.
2. Disable auto-send. Tap, speak, tap: verify the whole transcript is reviewable and no agent work
   starts until Send. Discard once and re-record once. Repeat with both speech
   modes (buffered OpenAI is not live transcription). Enable auto-send and verify
   Stop sends once without review, then reopen and check the saved preference.
3. Send a read-only request to list apps on a named Mac. Verify tool names appear
   on the glasses, swipes retain partial pages, and Recent retains the answer.
4. Double-tap while working, choose keep waiting, then repeat and confirm Stop.
   Verify no unintended microphone start, app exit or request replay.
5. For an approved desktop action, unlock the selected Mac and grant approval
   there. Verify the correct desktop receives input, never another paired Mac.

Hub upload, device installation, visual layout and physical gestures have not
been verified by these automated checks.
