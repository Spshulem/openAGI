# Computer Use End-to-End Parity Plan

## Goal

OpenAGI can complete an approved desktop task on a selected Mac by repeatedly
observing fresh visual and semantic state, acting on coordinates or semantic
elements, and verifying the result. A transport-only implementation is not
complete.

## Required user-visible capabilities

- Discover safe applications and activate one by bundle identifier.
- Read one fresh state containing a live screenshot and a bounded,
  privacy-filtered Accessibility tree with stable per-frame element indices.
- Click by element or coordinate, including double click.
- Drag, move, type, paste plain/Markdown/HTML while restoring the clipboard,
  press key chords, and scroll by coordinate or element.
- Set an editable element value, select matching text, and invoke an exact
  secondary Accessibility action exposed in the fresh state.
- Re-observe after every mutating action. Element indices and screenshot frames
  expire together and cannot be reused after an action.
- Show approval, active-session, progress, Stop, and terminal results in the
  floating panel and dashboard without raw JSON.

## Safety invariants

- Computer Use remains opt-in and starts only after a visible, durable approval
  for an immutable goal and selected node.
- Every action is authenticated, lease-bound, sequenced, action-limited,
  time-limited, idempotent, and recorded before execution.
- Every coordinate and semantic action is bound to the exact focused window
  from a fresh state. Focus, window identity, privacy policy, lock state,
  Accessibility, Screen Recording, and Secure Input are revalidated locally.
- Password/secure text elements and excluded applications/windows fail closed.
- Typed, pasted, selected, or set values never enter argv, durable chat/tool
  transcripts, action logs, errors, or node capability reports.
- Cancellation always releases pressed keys and mouse buttons. Stop revokes the
  lease and prevents queued or subsequent input.
- Node credentials and provider/integration secrets never cross into helper or
  optional backend subprocess environments.

## Supported execution paths

- Signed native macOS helper: full capability set and release default.
- Authenticated paired-node relay: the same contract over outbound polling,
  with no inbound node port required.
- Explicit HTTP node: the same contract behind the existing pinned-origin and
  bearer-token boundary.
- Optional Cua backend: advertise and execute only capabilities actually
  verified from the configured driver; never fabricate parity.

## Local completion gate

The PR remains draft until all of the following are true:

1. JavaScript and Swift unit/integration suites pass with the bundled release
   Node and the installed Xcode toolchain.
2. A fresh signed app build passes strict code-sign verification.
3. The real signed helper reports Screen Recording and Accessibility ready.
4. A local end-to-end task exercises approval, app activation, fresh state,
   semantic element action, coordinate action, text/value action, clipboard
   restoration, post-action observation, Stop/end, and audit-history rendering.
5. An authenticated relay smoke exercises the same request serialization and
   action result path rather than directly calling executor internals.
6. Negative smokes prove stale frame, changed focus, secure element, expired
   lease, invalid element/action, cancellation, and node-auth failures fail
   closed.
7. The full staged diff and publication range pass the Git safety guard and a
   public-repository security review.
8. A verification report records every check and contains zero unresolved
   failures or concerns in scope.
