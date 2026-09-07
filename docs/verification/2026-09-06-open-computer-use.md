# Open Computer Use adapter verification

- Upstream `iFurySt/open-codex-computer-use` v0.3.3 selected, MIT license.
- The exact npm archive passed the pinned SHA-512 check and its Mac app passed
  `codesign --verify --deep --strict`. Installed under the operator's OpenAGI
  tools directory, without changing the active backend or agent configuration.
- A real local MCP initialize and tools/list succeeded against the installed
  native executable, returning all nine upstream tools. The process was closed
  afterward. This test did not capture the screen or perform input.
- The installed native executable's `doctor` reported Accessibility and Screen
  Recording granted on this Mac. No permission settings were changed.
- 47 focused Node 22 tests passed: adapter, bounded stdio transport,
  computer-server leases/authentication/frames, Cua compatibility, readiness,
  canonical data directory, and environment persistence.
- Tests cover wrong-window rejection, element-index mapping, screenshot pixel
  coordinates, stale frames, unsupported operations, archive substitution,
  error responses, cancellation, and timeout termination. Test data is synthetic.

## Merge validation follow-up

The merge candidate adds a transport regression for valid JSON that is not a
JSON-RPC object (`null`, arrays, primitives, and missing protocol version).
These responses now terminate the owned engine and reject pending requests,
instead of escaping the callback and crashing the OpenAGI daemon. The focused
suite now passes 48 tests. The signed native helper reports ready on this Mac.
Desktop input was not attempted: no disposable TextEdit document was available.
Another 34 approval, toggle, and authenticated node-control tests passed,
bringing merge validation to 82 passing tests. These include target binding,
revocation priority, expiring queued work, and refusal to replay physical work
after a failed continuation. They use isolated test stores and simulated nodes;
they are not a substitute for physical multi-Mac acceptance.

## Physical acceptance required before default promotion

Run against a build containing PR #94 on **each controlled Mac**, with the
pinned engine installed and both engines' macOS permissions granted. Use a
blank unsaved TextEdit document only, with no private windows in view. Select
the experimental backend explicitly for the test; do not change all nodes.

1. **Target and approval:** From OpenAGI/G2 ask to type `OpenAGI desktop test`
   on the named Mac. Confirm the approval names that Mac and the intended goal.
   Deny once: nothing should change. Ask again and approve: only the selected
   Mac's blank document should receive the text. Repeat on the other Mac.
2. **Basic control:** In the disposable document test typing, a key shortcut,
   an element click, a coordinate click on Retina, dragging, and scrolling.
   Confirm position and visible effects, not just an accepted receipt.
3. **Stop:** Start a multi-step edit, press OpenAGI's Stop while it is running,
   and confirm no subsequent steps occur. Continuing must require fresh consent.
4. **Staleness and privacy:** Between capture and input, switch to another
   window; input must be refused rather than redirected. Focus a harmless app
   excluded by OpenAGI's Capture privacy settings: no image or text from it
   should reach the agent. Lock the Mac and confirm control refuses to continue.
5. **Consent expiry:** Leave an approved control lease idle for over two
   minutes, then attempt another action. It must require a new lease/consent.
   Automated tests separately cover the absolute 15-minute lease limit.
6. **Audit and routing:** Inspect the Computer Use log: selected node, approval,
   attempted action, result/refusal, and cancellation should agree with what
   physically happened. Disconnect one Mac; the main must not route its pending
   instruction to the other Mac or replay it after reconnecting.

Report the Mac name, action, visible result, approximate time, and any error.
Do not send private screenshots. Native remains a temporary migration fallback;
do not remove it or declare the default migration complete until this acceptance
passes **and** the upstream app/window dispatch limitation below is resolved.

## Not verified / release gate

No physical screenshot/click/type round trip, multi-Mac control, or
default-backend migration is claimed. The adapter is
experimental and opt-in. Existing native control remains the default; the
signed native helper is still required for privacy checks and fallback actions.
Upstream app targeting does not provide an atomic OpenAGI window-identity check
at event dispatch. Validate this limitation before promoting the backend for
sensitive/unattended work. The setup guide lists the reduced operation set.
