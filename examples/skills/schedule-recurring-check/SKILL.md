---
name: schedule-recurring-check
description: Set up a recurring check that only does work (and spends tokens) when there's something new — e.g. "every hour, check BuildBetter for new calls".
---

The user wants a recurring check. Design it as a CHEAP probe that only acts on a delta — never a blind poll that burns tokens on an empty result.

1. Pin down three things:
   - WHAT to check (which tool/source — e.g. a BuildBetter search, a Linear query, an MCP tool via `run_mcp_tool`).
   - HOW OFTEN (a fixed interval, or a daily time).
   - What "new" means here — the cursor that separates old from new (a since-last-run timestamp, an id you haven't seen, a count that changed).

2. Create it with `schedule_message`:
   - `prompt`: a SELF-CONTAINED instruction that, when it fires, will:
     (a) fetch only items newer than the last check (use the cursor),
     (b) if there is NOTHING new → reply with a single short line like "nothing new" and STOP (don't elaborate, don't call more tools),
     (c) only if there IS something new → summarize it and/or take the action the user asked for.
   - `intervalSeconds` (recurring every N seconds) OR `dailyAt` "HH:MM".
   - Leave `channel`/`target` default so the result returns on the user's channel.

3. Confirm back: what you scheduled, how often, and how to stop it (`list_cron_jobs` to find the id, then `cancel_cron_job`).

Principle: react to deltas, not to the clock. The fired prompt must short-circuit cheaply when nothing changed — that's what keeps an idle agent at ~$0.

User asked: {{input}}
