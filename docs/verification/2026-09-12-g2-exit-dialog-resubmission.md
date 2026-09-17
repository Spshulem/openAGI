# G2 0.4.17 resubmission: root exit dialog

## Rejection evidence

The user supplied this reviewer feedback verbatim on September 12, 2026:

> Other: Please ensure double tapping can invoke exit dialogue at the root page to follow the normal app feature UX logic. See shutDownPageContainer(1) at [https://hub.evenrealities.com/docs/guides/page-lifecycle#methods](https://hub.evenrealities.com/docs/guides/page-lifecycle#methods) for more information.

This is the one supplied review item, not a claim that other portal/email
feedback was retrieved. The linked guide has moved to
<https://hub.evenrealities.com/docs/build/page-lifecycle#methods>. The live guide
states: "Pass 1 for the system exit-confirmation dialog (required on the root
page); pass 0 for immediate exit (internal pages only)."

## Change

- Home, unpaired home, quiet-listening and reconnecting root double-taps invoke
  the native SDK call with argument `1`; no custom confirmation or mode-0 exit.
- Native exit events, not opening the dialog, stop input, speech, audio and
  ongoing requests. The phone Exit button uses the same confirmation path.
- Recent remains on swipe. Child screens retain Back/discard/cancel semantics.
- Listening can still be paused on glasses: swipe down, then tap Pause listening.
- The package version advances once from the rejected 0.4.16 to 0.4.17. No main
  server update is required for this gesture fix.

## Verification and resubmission gate

Automated verification (Node 24, SDK 0.0.15, Vitest 4.1.10):

- 18 OpenAGI test files, **184 tests passed**.
- Full assembled-client `tsc --noEmit`: passed.
- Targeted lint for the native-exit wiring, renderer, controller and new tests:
  passed. Broader lint still reports pre-existing errors in the existing
  app/live-speech tests and recovery code; this is not a whole-repository lint pass.
- The test assembly uses the same compatible G2 base source retained with the
  0.4.16 submission assets, with this repository's overlay applied. The older
  dirty checkout and live G2 workspace are unchanged.

### Original built candidate (superseded by review cleanup)

- Overlay source commit: `4c28b3b9e31e33a5110e45a1a3e808beefa73f3b`.
- Built on BuildBot3 in an isolated temporary directory, using Node 22.21.1,
  pnpm 10.24.0 and the frozen assembly lockfile. No containers or live services
  were started or changed.
- `pnpm package:agents` passed (TypeScript, Vite production build and Even Hub
  packaging). `pnpm check:bundle` and `pnpm check:secrets` passed.
- Artifact: `OpenAGI-Agent-0.4.17.ehpk`, 89,570 bytes, package ID
  `sh.agents.even.g2`, version `0.4.17`. Generic build: no default main URL or
  scoped credentials; users supply their own connection.
- Artifact SHA-256:
  `f27cc4d4c3ecc8f22d3ba67f276c490c96d4442837c59164143b42b69d994986`.
- The assembled source/configuration/lockfile inputs are retained alongside the
  bundle as `OpenAGI-Agent-0.4.17-build-input.tar.gz`, SHA-256
  `0573223788408ff8f5297f564cba962ae1fac851ea87e08125db8901189f569d`.
  They contain no environment exports or installed dependencies. This preserves
  the compatible base used for the previous submission as well as the overlay.

### PR review cleanup

Live `gh` inspection identifies PR #103 (`codex/g2-preserve-failed-question`) as
the exit-dialog PR, including source commit `4c28b3b`. The older
`codex/even-g2-node-integration` branch belongs to already-merged PR #91, not
#103. The separate open PR #102 is public coding-agent setup recovery.

The three Codex P2 findings and Cursor's medium finding on #103 are addressed:

- A completed API result survives local history errors; it is never offered as
  an uncertain-delivery resend.
- A partial streamed answer remains visible, with its incomplete label, instead
  of being replaced by a resend draft (including when history storage fails).
- Both live and buffered ambient triggers leave a retained review draft alone.
- Empty or duplicate final speech results no longer erase interim recovery text.

The updated client passes 192 tests, full assembled-client TypeScript, and lint
on all four changed source/test files. Existing lint issues within those files
were corrected without disabling rules. Version stays at the unreleased 0.4.17;
the original bundle checksum above must not be used for the rebuilt candidate.
The PR cleanup comment records the exact verified source commit, rebuilt bundle
SHA-256, build results and GitHub check state. No Even Hub action is authorized
by this review cleanup; physical acceptance remains unverified.

Physical G2 acceptance remains required; mocked SDK tests cannot prove the
native modal appears on hardware:

1. Install 0.4.17. At unpaired home, double-tap: the **Even system exit dialog**
   appears. Cancel: pairing UI remains usable.
2. Pair, ask a question, return home. Double-tap: the same native dialog appears,
   not Recent. Cancel, tap Ask, and verify pairing/history remain intact.
3. Start consented quiet lifelog. Double-tap: native exit dialog. Cancel: verify
   microphone status and newly saved text. Swipe down and tap Pause listening:
   microphone off, with explicit consent required for resume as before.
4. From an answer, Recent, inbox/detail, draft, and active request, double-tap
   performs Back/discard/request-cancellation confirmation, not app exit.
5. Confirm Exit: return to Even's launcher and verify capture stops. Reopen:
   pairing persists; any saved lifelog preference still validates consent.

Suggested reviewer response after device acceptance: "Root-page double-tap now
calls shutDownPageContainer(1) to display Even's native exit confirmation. Child
pages retain Back navigation. Cancelling the dialog leaves the app usable;
resources are cleaned up only when Even emits the system-exit event."

Not resubmitted automatically.
