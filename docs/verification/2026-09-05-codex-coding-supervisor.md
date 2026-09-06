# Verification Report: codex/coding-supervisor

**Date:** 2026-09-05

**Plan:** [Coding Agents setup and execution limits](../setup/coding-supervisor.md)

**PR:** [93](https://github.com/Spshulem/openAGI/pull/93)
**Branch:** `codex/coding-supervisor` (built-in supervisor follow-up)

## Summary

- 8 verification groups passed, with the evidence boundaries below.
- 3 concerns remain before broader installed/end-to-end claims.
- 0 unresolved actionable code/security findings in the final targeted review.
- 3 broader integration observations are outside this PR's proof.

This verifies a restricted built-in coding supervisor, not unrestricted autonomous writing or completion of the entire personal-agent readiness plan. The candidate is not yet installed or released.

## Detailed Findings

### Working as Expected

| Feature | Surface | What was verified | Screenshot |
|---------|---------|-------------------|------------|
| Fresh-install setup | Browser with isolated fake provider | Setup, selected Git folder persistence, and new-session controls worked without an external supervisor. | Observed inline; not saved |
| Complete start approval | Browser and Swift decoding tests | Full canonical workspace identity, model, effort, permission limits and instruction were reviewable before execution. The instruction's image markup remained literal. | Observed inline; not saved |
| Approved lifecycle | Authenticated HTTP and browser fixture | Queue, approval, accepted receipt, reload to idle and inspection completed. Receipt text explicitly distinguishes starting from task completion. | Observed inline; not saved |
| Provider execution | Actual installed Claude and Codex CLIs | Each ran in a new disposable Git project with the built-in fixed arguments and existing account authentication. Each returned the expected harmless marker, finished idle and exposed reply availability. No tools were requested. | Not captured |
| Process ownership and permissions | Source review and focused tests | Fixed argument vectors, limited child environment, owned-process Stop, deadlines, concurrency limits and restricted provider permission profiles were checked. | Not applicable |
| Crash recovery | Source review and focused tests | Interrupted workspaces stay quarantined until an explicit owner confirmation. Reconciliation does not kill a saved PID or resume the old session. | Not applicable |
| Bounded history and replay safety | Source review and focused tests | At the history bound, only terminal rows older than the approval window are eligible for retirement. Working/interrupted rows remain; expired start approvals are rejected before record lookup. | Not applicable |
| Responsive layout | Browser fixture | Document and pane widths matched 1440-, 768- and 375-pixel viewports with no horizontal overflow. Mobile rendering was visually inspected. | Observed inline; not saved |

### Mismatches / Broken

No unresolved actionable findings in the final targeted code/security review. The prior permanent interrupted-workspace lock and permanent 100-record exhaustion both have recovery paths and regression coverage. The previously observed tablet/mobile overflow was not reproduced after the layout fix.

### Concerns

| Feature | Issue | Required follow-through | Screenshot |
|---------|-------|------------------------|------------|
| Installed native behavior | Tests and source review do not establish signed installed-panel behavior or actual native notification delivery. | Validate the installed candidate's notification, full-review and Stop surfaces before claiming release completion. | Not captured |
| Provider capability depth | Real provider smoke requested a harmless text response without tools; it does not demonstrate repository edits, tool permission handling or a real follow-up resume. | Exercise explicit disposable workflows within the declared permission profile. Codex remains read-only and Claude requires separate permission decisions. | Not captured |
| Cost and autonomy limits | Provider CLI usage is independent of OpenAGI's chat budget. The profile intentionally does not provide unrestricted autonomous writing. | Preserve the visible cost/permission warnings and describe these limits accurately. | Not applicable |

### Out of Scope

| Observation | Where | Notes |
|-------------|-------|-------|
| Live daemon and cron | Separate live audit | Main verifier reported a healthy daemon with no overdue or running cron jobs. These were not changed or established by the fixture. |
| iMessage and nodes | Separate live audit | Main and iMessage node were reported online with fresh status. No actual iMessage send/reply round trip was verified. |
| Computer use and G2 | Broader readiness work | Local input readiness was reported, but physical input, end-to-end G2 and installed native notification behavior were not exercised. |

## Edge Cases & Error States Tested

| Scenario | Result | Notes |
|----------|--------|-------|
| Invalid folders, root/home paths and duplicated selections | PASS | Focused setup validation tests. |
| Confirmation bypass, duplicate execution and stale approval | PASS | Authenticated routes and durable approval regression coverage. |
| Busy workspace, concurrency and owned-process timeout | PASS | Fixture process ownership/deadline coverage. |
| Restart with unknown process ownership | PASS | No automatic kill/resume; explicit owner reconciliation is required. |
| Full terminal history | PASS | Old terminal rows can be retired without clearing uncertain owners. |
| Long instruction and hostile markup | PASS | Full review content remains available; browser renders markup as text. |
| Empty provider output | PASS | Fixture classifies unverified/empty output as failure. |

## Runtime Surface Proofs

| Surface | Proof | Result | Notes |
|---------|-------|--------|-------|
| Focused JavaScript | 52 tests across built-in/supervisor, computer-use readiness and outreach mapping | PASS | Reported by main verifier; not a fresh full CI/build result. |
| Swift approval tests | 9 `PendingApprovalTests` | PASS | Rerun passed after the final cost notice edit. Existing unrelated Swift 6 isolation warnings remain. |
| Browser-to-HTTP approval path | Isolated fake-provider setup/start/review/approve/inspect flow | PASS | Crosses real UI, serialization, routing and approval boundaries without touching an existing coding session. |
| Actual Codex CLI | Disposable project, restricted fixed arguments, harmless expected text | PASS | Authentication and initial execution only; no coding tools requested. |
| Actual Claude CLI | Disposable project, manual-permission fixed arguments, harmless expected text | PASS | Authentication and initial execution only; no coding tools requested. |

## Responsive Checks

| Page | Desktop | Tablet | Mobile | Notes |
|------|---------|--------|--------|-------|
| Coding Agents with inspected transcript | PASS: 1440 | PASS: 768 | PASS: 375 | Document and pane widths matched each viewport. Mobile screenshot inspected inline, not saved. Approval flow tested separately at the default viewport. |

## Review disposition

The targeted process-ownership, approval-binding, environment, permission, fresh-install lifecycle and responsive-layout review found no remaining actionable defect after the reported fixes. The restricted implementation and the above tests support further release validation; they do not support a claim of 100% autonomous coding or complete cross-device personal-agent functionality.
