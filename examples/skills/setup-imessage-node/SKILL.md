---
name: setup-imessage-node
description: Guide setting up a Mac as an iMessage node — relays incoming texts to the main agent (trigger word) and answers iMessage searches.
---

Walk the user through turning a Mac (signed into iMessage) into an iMessage node. macOS-only, and it needs system permissions you can't grant for them — so produce clear, copy-pasteable steps and explain each grant. Substitute `<host>`, `<port>`, `<secret>`, `<TriggerWord>` for their values; never hardcode real numbers/tokens.

Two processes (run from the openAGI repo on that Mac):
- `openagi imessage-bridge --respond trigger --trigger <TriggerWord> --allow <handle,handle> --allow-chat <chatId> --capture all`
  Reads `~/Library/Messages/chat.db` read-only, relays messages containing the trigger to the main, and replies via Messages. Omit `--allow*` to respond to everyone; `--allow-chat` opts a group thread in.
- `openagi imessage-server --token <secret> --port <port>` (optional)
  Serves iMessage SEARCH to the main, giving it a `search_imessages` tool.

Steps to give the user:
1. Clone/run the openAGI repo on the Mac.
2. System Settings → Privacy & Security: grant the runtime that launches these (the `node` binary; Terminal while testing) **Full Disk Access** (read chat.db) and **Automation → Messages** (send replies).
3. Run the bridge (and optionally the search server). For persistence install a launchd USER agent (`RunAtLoad` + `KeepAlive`) that runs the command; restart it with `launchctl kickstart -k gui/$(id -u)/<label>`.
4. On the MAIN agent host, point at the node: `OPENAGI_IMESSAGE_NODE=http://<host>:<port>` and `OPENAGI_IMESSAGE_NODE_TOKEN=<secret>`, then restart.

Gotchas to mention:
- chat.db MUST be opened read-only — a read-write connection on the live WAL database can hang/crash Messages.
- On recent macOS the message text often lives only in `attributedBody` (the `text` column is NULL); the bridge decodes that typedstream blob.
- A process launched by launchd needs its OWN TCC grant — granting Terminal is not enough; the launchd-spawned `node` must be approved separately.
- Track messages by date, not ROWID (a chat.db rebuild renumbers ROWIDs non-chronologically).

User asked: {{input}}
