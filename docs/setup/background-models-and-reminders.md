# Foreground models and background reminders

`OPENAI_MODEL` remains the foreground model: direct chat, including G2 questions
and the coordinating agent's supervisor tool loop. It is not necessary to use
that model for routine scheduled prompts or internal maintenance.

To use Luna for background work while preserving the selected foreground model:

```dotenv
OPENAI_MODEL_MINI=gpt-5.6-luna
OPENAI_MODEL_NANO=gpt-5.6-luna
OPENAI_MODEL_TASK_AUTOPILOT=gpt-5.6-luna
OPENAI_MODEL_TASK_SCHEDULED=gpt-5.6-luna
```

Existing per-task pins override tiers; check them with `openagi models`. Configure
these values in the main's canonical environment, not the glasses bundle. Restart
the main after changing its environment. This does not alter the daily spending
cap or independently authenticated Codex/Claude CLI model settings.

Scheduled work is classified by its origin, not its delivery channel. A reminder
delivered to local chat, iMessage, or G2 still uses the scheduled-task model.

The `schedule_message` tool requires exactly one timing field. `delaySeconds`
creates a one-shot; `intervalSeconds` explicitly creates recurrence, with a
minimum interval of five minutes; `dailyAt` is a validated HH:MM value. Identical
pending schedules are reused, including paused copies (never silently resumed).
Scheduled prompts cannot recursively create more scheduled prompts. A one-shot
is persistently paused before execution; if the provider fails it remains paused
for inspection instead of recurring indefinitely. Successful one-shots are removed
as before. Internal non-model polling jobs retain their existing intervals.

These controls prevent common duplication and retry loops, but are not a total
background spending quota. All model-backed work still shares the existing daily
budget. The ledger is an estimate, not a provider invoice; do not erase recorded
usage or raise the cap to hide unexpected activity.
