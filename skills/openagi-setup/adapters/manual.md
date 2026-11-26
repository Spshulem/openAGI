# Manual setup (no coding agent)

Use this if you don't have Claude Code or Codex, or prefer to do it yourself.
It follows the same steps as `SKILL.md`. Replace `OA` with the command for your
install (see "Find the CLI" in `SKILL.md`), for example `node /opt/openagi/bin/openagi.js`.

1. **Check the daemon.** Run `OA doctor`. If the daemon is unreachable, start
   OpenAGI (the Mac app, `sudo systemctl start openagi`, `docker start openagi`,
   or `./start-openagi.sh`).
2. **Pick a model.** Run `OA provider`.
   - Claude Code subscription: run `claude auth login`, then
     `OA provider use claude-cli`.
   - Codex subscription: run `codex login`, then `OA provider use codex-cli`.
   - API key, ChatGPT sign-in or local model: open
     `http://127.0.0.1:43210/setup` and use **Connect & verify**.
3. **Dashboard login.** If `OA doctor` still says `setup … first-run`, open
   `http://127.0.0.1:43210/setup` and save your dashboard login.
4. **Smoke test.** `OA doctor` should show ✓ for daemon, setup and model.
   Then run `OA chat "Reply with exactly: openagi-setup-ok"` and expect a
   real model reply.
5. **If something fails**, see the Recovery section of `SKILL.md`.

Never paste a key or the OpenAGI auth token into a chat, an issue, or a
command line.
