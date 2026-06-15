---
name: diagnose-no-imessage-replies
description: Troubleshoot why the agent stopped replying to iMessages, in priority order.
---

Work through these in order and stop at the cause. Report the cause and the specific fix.

1. Budget cap. Check the daily budget. When the cap is hit the agent goes SILENT with no error (texts just stop). Raise the limit or wait for reset.

2. Bridge alive + ingesting. Is the iMessage node still feeding messages in? Look for recent inbound items (source "import", tagged `imessage`) via recall/memory. If the newest is hours/days old, the bridge process on the node is down — have the user restart it (`launchctl kickstart -k …`) and confirm Messages.app is running and signed into iMessage.

3. Text decoding. Are recent captured messages real text, or a replacement char (`�`)? If they decode to `�`, the attributedBody decoder is failing on that node's macOS, so the trigger word never matches. Update + restart that node's bridge.

4. Trigger + allowlist. A reply requires the trigger word (whole-word match) from an allowed sender or chat (unless the bridge runs with `--respond all`). Confirm the message actually contained the trigger and the sender/chat is on the allowlist.

5. Node asleep. A sleeping Mac stalls Messages sync and `osascript` sends. IMPORTANT: silent mode / Do Not Disturb does NOT affect the bridge — it reads chat.db and sends via Messages regardless of notification settings. Only the machine SLEEPING breaks it; keep the node awake.

Most of these require the user to act on the node itself (you usually can't SSH it) — give them the exact step.

User asked: {{input}}
