---
name: deploy-update-node
description: Roll out new openAGI code to the main and to Mac nodes (iMessage / computer-use), and restart them safely.
---

Roll out updated code. Critical fact: the MAIN self-updates its own git checkout, but each NODE runs off its OWN separate checkout and does NOT receive the main's update — every node must pull and restart itself.

Main agent host:
1. Trigger a self-update (fast-forwards `main` and restarts the daemon). After it comes back, confirm the new commit is live before assuming the fix is deployed.

Each Mac node (iMessage bridge, iMessage search server, computer-server):
1. In that node's repo: `git pull origin main`.
2. Restart the node's service:
   - launchd: `launchctl kickstart -k gui/$(id -u)/<label>` (e.g. `app.openagi.imessage-bridge`, `app.openagi.computer-server`).
   - run by hand: stop it and re-run the same `openagi <subcommand>` line.
3. Confirm: the process restarted (new pid) and the capability still works — the node's `/health`, a test `search_imessages`, or a test `/screenshot`.

Guidance for the user (you usually can't SSH their nodes):
- Give the exact `git pull` + restart commands for each affected node.
- Emphasize: a fix to node-side code (imessage-bridge, computer-server) only takes effect after THAT node pulls + restarts — updating the main is not enough.
- Never restart something you didn't start without telling the user first.

User asked: {{input}}
