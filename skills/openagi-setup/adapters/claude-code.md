# Adapter: Claude Code

Read `../SKILL.md` first. That file holds the setup procedure. This page covers
only how to run it inside Claude Code.

- **Where it is installed.** `~/.claude/skills/openagi-setup/` (personal skill).
  Claude Code loads it automatically when the request matches. You can also
  read `SKILL.md` directly from that folder.
- **Running checks.** Use the Bash tool for read-only checks (`OA doctor`,
  `OA provider`, `uname -sm`). Keep the default permission mode.
  Never suggest `--dangerously-skip-permissions` or `bypassPermissions`, and
  don't add allow rules to get past a prompt.
- **Sign-in commands.** Claude Code can't type into an interactive login for
  the person. Ask them to run `claude auth login` or `codex login`
  themselves, either in another terminal or by typing `! claude auth login`
  at the Claude Code prompt so it runs in their session. Then continue with
  `OA provider`.
- **Nested Claude.** If OpenAGI will use `claude-cli`, the daemon runs the
  `claude` binary itself as a separate, locked-down process. Being inside
  Claude Code right now does not count as OpenAGI being signed in. Only
  `OA provider` reporting "signed in" does.
- **Secrets.** Don't Read `.env`, `~/.claude.json`, `~/.claude/` credential
  files, or `~/.codex/auth.json`. Claude Code may show file contents in the
  transcript.
