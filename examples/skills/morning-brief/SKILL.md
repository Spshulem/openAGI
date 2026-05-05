---
name: morning-brief
description: Produce a short morning brief — what's on the calendar of cron jobs today, what the agent remembered recently, and any open follow-ups.
---

Compose a morning brief for the user.

1. Call `list_sessions` to see active conversations.
2. Call `recall` with the query "follow up open todo reminder" to surface anything still pending.
3. Output a concise brief in this shape:

**Today's check-ins**
- (cron jobs scheduled to fire today, derived from /cron — if no tool surfaces them, infer from session metadata)

**Open follow-ups**
- (top recall hits)

**Last conversations**
- (top 3 sessions)

Keep it under 200 words. User context: {{input}}
