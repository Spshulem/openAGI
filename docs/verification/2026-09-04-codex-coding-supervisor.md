# Verification Report: codex/coding-supervisor

**Date:** 2026-09-04

**Plan:** [Coding Agents setup and boundaries](../setup/coding-supervisor.md)

**PR:** Draft publication follows verification

**Branch:** `codex/coding-supervisor` (uncommitted candidate at review)

## Summary

- 8 verification groups passed through source review, browser checks and reported tests.
- 3 validation concerns remain; this is not a claim of installed or live-provider completion.
- 1 browser layout failure remains at tablet and mobile widths. The final targeted safety/source review found no additional actionable defects.
- 3 broader readiness areas remain outside this change.

## Detailed Findings

### Working as Expected

| Feature | Surface | What was verified | Screenshot |
|---------|---------|-------------------|------------|
| Exact-session approval | Authenticated HTTP and registry | Fixture listing, inspection, preparation, approval and one delivery cross the real hosted routes. Client confirmation flags and backend paths do not bypass preparation. | Not applicable |
| Duplicate and uncertain delivery | Journal and registry tests | Replay protection, expiry, changed identity and uncertain-delivery handling are covered by focused tests. Blocked/unconfirmed receipts become execution errors rather than successful tool results. | Not applicable |
| Complete instruction review | Swift decoding and interactive dashboard | A long instruction queued without sending; Open approval displayed its full tail and cost warning as readable text, not JSON. Missing structured Swift details direct the user to dashboard review. | Observed inline; not saved |
| Notification approval boundary | Outreach mapper, action route and Swift presenter | Coding approval notifications are review-only. Legacy outreach execution is rejected before claiming the pending action. | Native banner not exercised |
| Coding attention | Notification policy tests and source | Coding-agent transitions are eligible for notification outside quiet hours; review opens Coding Agents on the configured main. Service tokens are not added to the review URL. | Native banner not exercised |
| Stale state and navigation | Dashboard source, focused tests and browser | Source retains a 503 snapshot with its warning and disables replies. Browser navigation directly to Coding Agents loaded the intended page. | Observed inline; not saved |
| Adapter isolation | Adapter tests and source | Fixed operations, exact IDs, bounded subprocess/output/deadlines, loopback-only credential transport and refusal to kill attached writers are covered. | Not applicable |
| Browser execution boundaries | Coding Agents and Approvals fixture | Inspection rendered a malicious image string literally. Approval removed the pending card and showed a recent approved fixture receipt. An attached Claude fixture exposed only its owning-app warning, with no reply composer. | Observed inline; not saved |

### Mismatches / Broken

| Feature | Expected | Actual | Severity | Screenshot |
|---------|----------|--------|----------|------------|
| Responsive layout | Coding Agents and Approvals usable within tablet/mobile viewport widths | Document scroll width was 1230 pixels at both 768-pixel tablet and 375-pixel mobile viewports. Desktop 1440-pixel width matched its document scroll width. | Medium | Observed inline; not saved |

Do not mark the UI production-ready until this overflow is fixed and rechecked. Unperformed acceptance checks are not passes.

### Concerns

| Feature | Issue | Required verification | Screenshot |
|---------|-------|-----------------------|------------|
| Installed native app | Swift tests do not demonstrate actual notification banners or full-instruction scrolling in a signed installed build. | Verify the notification and floating-panel paths in the release candidate. | Not captured |
| Provider delivery | Read-only subprocess discovery returned 100 sessions and 92 reported reply routes. Actual bridge health and instruction delivery were not measured. | Choose disposable Claude and Codex sessions, verify authenticated bridge readiness, exact-target delivery and resulting work. | Not captured |
| G2 and orchestration breadth | Physical G2 round trips, new-workspace provisioning and model/effort selection are not established by this adapter. | Validate G2 separately; do not describe this change as the full personal-agent readiness goal. | Not captured |

### Out of Scope

| Observation | Where | Notes |
|-------------|-------|-------|
| Daemon recovery release | Separate recovery change | This bridge does not prove installed fatal-error recovery or change the published app version. |
| Computer use and iMessage | Existing integrations | No physical input or message send was performed as part of this verification. |
| Mail, calendar and memory usefulness | Broader readiness plan | Account authentication and demonstrated usefulness remain separate acceptance work. |

## Edge Cases & Error States Tested

| Scenario | Result | Notes |
|----------|--------|-------|
| Unauthenticated access and untrusted Origin | PASS | Authenticated HTTP fixture rejects unauthorized requests. |
| Caller-supplied confirmation context | PASS | Reply route only forwards provider, exact session ID and message. |
| Repeated approval | PASS | Fixture proves one send, then conflict on replay. |
| Provider blocked or delivery unconfirmed | PASS | Focused test coverage and reviewed handler preserve failure semantics. |
| Legacy notification execution shortcut | PASS | Reported HTTP regression proves rejection before execution. |
| Long instruction | PASS in browser and Swift decoding | Browser displayed the full tail and cost warning. Native visual proof remains outstanding. |
| Malicious transcript markup | PASS | Browser rendered the image markup literally, not as an executable element. |
| Attached Claude fixture | PASS | Owning-app warning appeared without a reply composer. |
| Remote/redirecting or stalled bridge | PASS | Focused adapter tests cover network restriction and response bounds. |

## Runtime Surface Proofs

| Surface | Proof | Result | Notes |
|---------|-------|--------|-------|
| Hosted HTTP | Temporary-state fixture through authenticated list/inspect/reply/approve routes | PASS | Fake delivery backend; no live coding session changed. |
| Focused JavaScript suite | Main verifier reported 46 passing focused tests | PASS | Not a full repository or CI result. |
| Full JavaScript package suite | `node --test --test-reporter=dot` exited 0 | PASS | Exact test count was not captured; this is not a full build or CI result. |
| Swift focused suite | `PendingApprovalTests`: 8 of 8 passed | PASS | Native notification delivery and signed visual behavior remain unverified. |
| Existing supervisor discovery | Real read-only subprocess returned 100 sessions and 92 reported reply routes | PASS for discovery only | No actual bridge health or delivery proof. Private configuration and conversation contents are excluded. |
| Interactive browser fixture | Direct navigation, inspect, queue, full review, approve and terminal receipt | PASS | Disposable fake sessions only; no real provider send. |
| Real provider send | Not performed | NOT VERIFIED | Requires chosen disposable sessions. |

## Responsive Checks

| Page | Desktop | Tablet | Mobile | Notes |
|------|---------|--------|--------|-------|
| Coding Agents and Approvals | PASS: 1440 viewport / 1440 document width | FAIL: 768 viewport / 1230 document width | FAIL: 375 viewport / 1230 document width | Horizontal overflow remains. Screenshots were observed inline, not saved. |

## Cleanup

The main verifier closed the temporary browser tab, reset the viewport and stopped the fixture service. Existing coding sessions were not sent messages or resumed.
