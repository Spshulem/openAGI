# G2 / Open Computer Use hardening

## Implemented

- Own upstream's actual dispatcher by disabling its LaunchServices app-agent
  proxy. Preserve private stdin, credential isolation and disabled global
  pointer fallback. Late output/errors from a retired process cannot close a
  replacement process.
- Combine upstream permission readiness with OpenAGI's existing privacy gate.
  Preserve actionable native readiness detail instead of replacing it with a
  generic ready message. Missing upstream grants cannot advertise control-ready.
- Bind the upstream window header to its actual header line; a matching string
  inside document content is not sufficient.
- Propagate request cancellation through computer tools into main-side consent
  revocation and the selected node's priority cancellation path. Check again
  after lease creation and refuse late success after cancellation.
- Centralize the reviewed upstream version/archive/digest; add a path-filtered
  compatibility workflow. No automatic upstream updates or permanent fork.

## Evidence

- 48 focused Node 22 tests pass across request cancellation, adapter/transport,
  approvals, node routing and G2 provider cancellation. Synthetic tests verify
  cancellation during lease creation, typing, and capture; another chat's
  approval remains untouched. They do not prove physical G2 gestures.
- Three additional transport/pin/probe regressions pass, for 51 distinct
  focused tests in this change's verification runs.
- With the app-agent proxy disabled, the installed v0.3.3 executable completed
  MCP discovery for all nine tools and captured TextEdit on this Mac.
- The upstream permission probe reports both permissions granted. No permissions
  or live runtime configuration were changed.
- A newly-created blank TextEdit document passed native activation, the
  adapter's before/after exact-focus checks, OCU capture, adapter typing, and
  independent OCU readback of `OpenAGI isolated engine test.` The temporary
  executor lease was closed afterward. This is a local adapter smoke test,
  not a main approval or physical G2 round trip. The unsaved scratch remains
  open; existing documents were not edited.

## Remaining production gate

Upstream's dispatcher accepts an app, not OpenAGI's expected window ID or its
privacy/secure-field rules. Pre-dispatch checks outside that process cannot
guarantee those rules for every physical event. Default promotion and native
retirement are intentionally not performed. A physical successful edit alone
does not close this gap. The previous focus/type failure did not reproduce in
this isolated-process smoke test; no broad focus-check relaxation was made.

After the dispatch guard is resolved and updated builds are installed on the
main and each Mac, physical acceptance requires: G2 ask -> named-Mac approval
(deny then approve) -> scratch edit; Stop during a multi-step edit; changed and
privacy-excluded windows; screen lock; expired consent; disconnect/reconnect
without rerouting or replay. Never use a password field or private document as
a test fixture. Record visible effects separately from accepted tool receipts.
