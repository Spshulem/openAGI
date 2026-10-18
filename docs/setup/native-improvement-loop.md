# Native improvement routing

OpenAGI can diagnose its own problems without treating every limitation as a coding task. The existing Fleet daily diagnosis now assigns each proposal one remedy:

| Remedy | Next step |
| --- | --- |
| Skill | Review a reusable procedure using existing tools; create it through the existing `create_skill` approval flow. |
| Clarification | Ask one targeted question before deciding what to change. |
| Setup | Explain the missing credential, permission, budget or service prerequisite. |
| Code | Offer an approved coding handoff to the existing self-fix worker. |
| Feature | Keep a local capability proposal and issue draft for owner review. |

Each private suggestion retains its remedy, next action, acceptance check, evidence references and fingerprint. Review plan shows those instructions without starting a worker, modifying a skill, answering a question on the owner's behalf, or resolving the finding. The owner can also choose Not now or Never. Only code remedies offer Fix it, and both local and remote coding handoffs enforce that rule. Existing saved suggestions without a remedy retain their previous code behavior.

Clarification cards offer **Answer question**. The page collects up to 2000 characters; voice accepts the owner's answer through `suggestion_respond` with `choice: "answer question"` and `clarification`. The answer stays with that private finding across restart. The next full diagnosis passes it as untrusted reference data to the configured explanation model and updates the same finding's classification and plan, even when the proposal queue is full. Model or budget failures retain the answer for a later diagnosis. Recording or reconsidering an answer does not verify a repair or close the finding. Review plan through outreach returns the plan successfully while leaving both the question and outreach item unresolved.

## Optional runtime checks

Set `OPENAGI_RUNTIME_IMPROVEMENTS=1` in the daemon's owner-controlled environment to include local provider configuration, enabled cron failures/overdue work, memory pressure with low recall, budget exhaustion and iMessage read errors in the existing daily Fleet diagnosis. Fleet must be enabled; this does not install or enable a scheduler or restart the daemon. Unknown/unavailable collectors are reported as unknown, not successful. iMessage status and configured provider state are readiness reports, not message-send or provider-execution receipts.

The checks use aggregate metadata only. They make no provider calls, reproduce no memory/message contents and never clean data or grant permissions. They produce local plans even when the explanation model is unavailable. Exhausting the runtime budget, including active voice reservations, skips the Fleet explanation model for that diagnosis. Running cron jobs are excluded from overdue counts; existing failures and idle overdue work remain visible. The existing hourly pass remains measurement-only; daily publication reuses persistent fingerprints, snoozes, the three-open-proposal limit and notification limits. A previously reported unchanged native problem makes no model call unless the owner supplies a clarification for reconsideration.

This first set of collectors is not the complete external daily audit. Physical input, screenshot capture, relay/send acceptance, all node/service reachability and installation acceptance still need separately authorized checks. Memory capacity or an overdue job alone is not proof of a code defect. These checks deliberately propose a skill or further diagnosis instead of starting a coder.

## Coding and token ownership

`OPENAGI_FLEET_SELF_FIX=propose` remains the default. Fix it uses the existing approval and selected coding-node path, isolated worktree, test/guard/replay gates, PR publication and bounded review repair. It does not grant permission to merge, install, restart, release or deploy.

For an owner/maintainer installation that explicitly wants autonomous PRs, the existing `auto` setting permits only code remedies that pass the confidence, concurrency, area-lock, node-readiness and daily-cap gates. Lower `OPENAGI_FLEET_SELF_FIX_DAILY_CAP`, `OPENAGI_FLEET_SELF_FIX_TOKEN_CAP`, `OPENAGI_FLEET_SELF_FIX_WALL_MS` and `OPENAGI_FLEET_SELF_FIX_ROUNDS` to the owner's desired repair budget. Coding uses the configured coding account, not arbitrary users' credentials. No public reporting or coding is enabled for other installations by this change. See [Fleet self-fix setup](fleet-supervisor.md#self-fix-runner).

The existing worker's replay metrics are Fleet-specific. A broader code repair requires an applicable acceptance adapter before it can pass publication; this change does not bypass that gate or claim generalized repairs work end to end.

## Local issue drafts and resolution

Code and feature plans include a local issue template. No issue is submitted and no GitHub issue permission is requested. The template deliberately excludes the private root cause, action IDs, logs and local next-action text; the owner supplies a minimal synthetic reproduction before publishing. This prevents every installation independently posting private or duplicate reports upstream.

Opening or merging a PR does not close the underlying problem. Keep coded, published, installed and verified-live states separate. Existing shared data is not reclassified automatically. Keep an external watchdog while the native loop depends on the daemon it is diagnosing.

## Verification

Run with Node 22:

```sh
node --test test/native-improvement-routing.test.js test/fleet-suggestions.test.js test/fleet-page.test.js test/fleet-tools.test.js test/fleet-routes.test.js test/self-fix-runner.test.js
```

The fixtures use temporary private stores and fake models/workers. They cover every remedy, non-code refusal across the handoff boundary, no model calls for native findings, budget gating, repeat/restart deduplication, unknown state, private-data exclusion, daily scheduling, the UI and existing worker behavior. They never start a real coding session or publish an issue/PR.
