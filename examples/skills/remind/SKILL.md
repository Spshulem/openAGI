---
name: remind
description: Create a one-shot reminder that pings the user back through their channel after a delay.
---

You are creating a reminder.

Parse the user's request to extract:
- the reminder text (what to say when it fires)
- the delay (in seconds) OR a daily HH:MM time

Then call `schedule_message` with:
- prompt: a short prompt that, when run later, will produce the reminder text the user wants to hear back
- delaySeconds OR dailyAt
- channel and target should be left to default (origin channel)

Confirm to the user what you scheduled and when it will fire.

User asked: {{input}}
