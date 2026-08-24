# Verification Report: codex/computer-use-e2e-finish
**Date:** 2026-08-24
**Plan:** `docs/superpowers/plans/2026-08-24-computer-use-parity.md`
**Base:** merged PR #83 (`f87af509b7142bed04ed5e869186fb200f5438b8`)

## Summary

- The PR #83 review findings are fixed locally: explicit-node drag routing, backward-compatible operation negotiation, and readable multi-click/drag audit copy.
- The live approval-overlay defect is fixed structurally: a privacy-excluded OpenAGI foreground window no longer makes an otherwise controllable node disappear; the approved loop may list and activate the target app before taking a fresh screenshot.
- The floating approval result now reconciles the matching terminal Computer Use session instead of staying on “continuing in Chat.”
- A fresh Developer ID signed app and nested helper pass strict code-sign validation.
- JavaScript: 1,036/1,036 passed in the authoritative serial suite.
- Swift: 37/37 passed.

**Result: INCOMPLETE — do not merge yet.** The only remaining gate is a real physical-input round trip after macOS Secure Input is released. During this run, Secure Input was owned by the Codex desktop process. The signed OpenAGI helper correctly reported Screen Recording and Accessibility granted, the screen unlocked and capturable, but refused synthesized input while that system safety lock remained active.

## Verified

| Area | Result | Evidence |
|------|--------|----------|
| Signed runtime | PASS | Fresh Developer ID signed `build/OpenAGI.app` and nested helper satisfy strict code-sign verification. |
| Approval-overlay readiness | PASS | Regression starts a lease with screenshots temporarily privacy-excluded, lists/activates the approved app, then regains a fresh frame. |
| Explicit node approval | PASS | Authenticated health is rechecked; input-ready nodes may start while the approval overlay is not capturable. |
| Backward compatibility | PASS | Baseline coordinate nodes remain control-ready without optional drag or semantic actions; leases advertise only negotiated operations. |
| Action contract | PASS | App discovery/activation, screenshot-bound coordinate actions, semantic element actions, multi-click, drag and redacted text operations are covered. |
| Visible audit | PASS | Click count/button and full drag endpoints/duration render as readable copy without raw JSON or typed content. |
| Overlay terminal state | PASS | Only the matching `session-end` SSE event replaces the running banner with finished/stopped copy; private runtime detail is not rendered. |
| Automated suites | PASS | 1,036 JavaScript tests and 37 Swift tests passed. |

## Remaining E2E Gate

1. Quit or otherwise release the application currently owning macOS Secure Input.
2. Launch the signed branch app.
3. Ask OpenAGI to open a disposable TextEdit document, type a unique harmless marker, verify it in a fresh frame, remove/close it without saving, verify cleanup, and end the session.
4. Confirm the floating approval banner reaches the matching terminal result.

No repository code bypasses Secure Input, changes system permissions, embeds installation-specific names, or weakens the screenshot/focus binding.
