# Adapter: Codex CLI

Read `../SKILL.md` first. That file holds the setup procedure. This page covers
only how to run it inside Codex.

- **Where it is installed.** `~/.codex/skills/openagi-setup/` (user skill).
  If this Codex version doesn't load user skills, read `SKILL.md` from that
  folder directly. The installer's opening prompt gives the full path.
- **Sandbox and localhost.** Codex's default sandbox may block network access,
  including `127.0.0.1:43210`. If `OA doctor` reports the daemon unreachable
  but the person says OpenAGI is running, ask Codex's normal approval
  prompt to run that one command outside the sandbox.
  Do not change `sandbox_mode` or set `approval_policy = "never"`.
  Never use `--dangerously-bypass-approvals-and-sandbox`, `--full-auto` or `--yolo`.
- **Sign-in commands.** Ask the person to run `codex login` or
  `claude auth login` themselves in a separate terminal. Codex can't complete
  an interactive browser sign-in for them.
- **Nested Codex.** If OpenAGI will use `codex-cli`, the daemon runs the
  `codex` binary itself as a separate process. Being inside Codex right now
  does not count as OpenAGI being signed in. Only `OA provider` reporting
  "signed in" does.
- **Secrets.** Don't open `~/.codex/auth.json`, `~/.codex/config.toml`
  credential sections, or the OpenAGI `.env`.
