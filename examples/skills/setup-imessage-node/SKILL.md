---
name: setup-imessage-node
description: Guide setting up a Mac as an iMessage node — relays incoming texts to the main agent (trigger word) and answers iMessage searches.
---

Walk the user through turning a Mac (signed into iMessage) into an iMessage node. macOS-only, and it needs system permissions you can't grant for them — so produce clear, copy-pasteable steps and explain each grant. Substitute `<host>`, `<port>`, `<secret>`, `<TriggerWord>` for their values; never hardcode real numbers/tokens.

The normal setup is one signed OpenAGI app process, not separate Node services:
- Set `OPENAGI_IMESSAGE_BRIDGE=1`, `IMESSAGE_RESPOND=trigger`, and `IMESSAGE_TRIGGER=<TriggerWord>` on the Messages Mac. Optional `IMESSAGE_ALLOW=<handle,handle>` and `IMESSAGE_ALLOW_CHAT=<chatId>` narrow who can invoke it. Ambient capture stays off unless explicitly enabled.
- Set `OPENAGI_IMESSAGE_SEARCH=1` only when the user wants the paired main to perform bounded read-only searches. Search travels over the authenticated outbound node relay; do not open an inbound iMessage port.

Steps to give the user:
1. Install and launch the signed OpenAGI app on the Mac, then pair it to the HTTPS main with `openagi pair <main>` using the documented hidden token input.
2. In OpenAGI Setup, enable the signed-app bridge and optionally history search. Restart OpenAGI so the daemon loads the settings and enrolls its scoped node credential.
3. System Settings → Privacy & Security: grant **OpenAGI.app** Full Disk Access (read chat.db) and **Automation → Messages** (send replies), then restart OpenAGI once more.
4. On the main, verify one fresh node heartbeat and the nested `imessage-search` capability. Send a harmless trigger message and confirm the bridge status records a successful poll before relying on it.

Gotchas to mention:
- chat.db MUST be opened read-only — a read-write connection on the live WAL database can hang/crash Messages.
- On recent macOS the message text often lives only in `attributedBody` (the `text` column is NULL); the bridge decodes that typedstream blob.
- Full Disk Access belongs to a code-signing identity. Do not replace the signed-app bridge with a checkout-specific Node LaunchAgent; that recreates the permission-loss bug on updates.
- Track messages by date, not ROWID (a chat.db rebuild renumbers ROWIDs non-chronologically).

User asked: {{input}}
