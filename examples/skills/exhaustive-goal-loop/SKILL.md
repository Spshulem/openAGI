---
name: exhaustive-goal-loop
description: "Multi-batch continuation loop for exhaustive goals ('clean all emails', 'all 888 QA issues', 'all customer rows') so work never stops after 10 items."
createdBy: owner
---

# Exhaustive Goal Continuation Loop

Use this skill whenever Spencer sets an exhaustive or multi-batch goal (e.g., *"go through all my emails"*, *"fix all 888 staging QA issues"*, *"verify all 10 Brex items"*, *"audit all 44 StayVista speaker rows"*).

## Non-Negotiable Continuation Contract
1. **Register or Update the Durable Goal First:**
   - Call `upsert_goal` with `title`, `goal`, explicit `doneCriteria`, `cadence: "continuous"`, and `cursor: { processed: 0, total: <known total or null>, remaining: <remaining> }`.
2. **Process a Bounded Batch Per Turn Without Pretending You Finished:**
   - Execute as many items as fit cleanly inside this turn's tool budget while respecting hard red lines (never merge PRs, never send external emails, never delete shared production data without approval; use drafts/labels/archives as instructed).
3. **Verify Against `doneCriteria` Before Stopping:**
   - At the end of the batch, call `verify_goal_progress` with the updated `cursor` (`processed`, `remaining`, `lastCursorToken`, `batchSummary`) and latest evidence.
   - Finishing 1 turn or 10 items is **NOT** done when `remaining > 0` or `doneCriteria` is unverified!
   - `verify_goal_progress` automatically keeps/enqueues the next continuation batch in `queue: "agent"` so the runtime continues automatically until `remaining === 0` and `doneCriteria` passes verification (or Spencer says stop).
