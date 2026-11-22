# Website factual checks

Checked 2026-11-21 from the fresh `origin/main` checkout (`4caf33dd`) and
official public pages. The preview is deliberately explicit about evidence
boundaries.

## OpenAGI

- `package.json` reports version `0.0.83`.
- GitHub latest release API reports `v0.0.83`, published 2026-11-20.
- Release assets checked: `OpenAGI-0.0.83.dmg`,
  `OpenAGI-Windows-x64.zip`, `OpenAGI-Linux-x64.tar.gz`,
  `OpenAGI-Linux-arm64.tar.gz`, and matching `.sha256` files.
- `docs/INSTALL.md` says macOS uses the DMG; Windows supports a published
  portable ZIP or PowerShell source path; Linux supports portable, source,
  installer, and Docker paths. Docker targets are Linux x64 and arm64.
- `README.md`, `WHITEPAPER.md`, `docs/abi-architecture.md`, and
  `docs/setup/fleet-supervisor.md` support the language about Directional
  Adaptive Scrutiny, Tiered Memory, Propagation, host-local state, supported
  coding sessions, Observe/Propose/Auto, and approvals.
- `LICENSE` is PolyForm Noncommercial 1.0.0. The page says source-available and
  does not call OpenAGI OSI-approved open source.
- `mobile/README.md` and `docs/INSTALL.md` describe iOS/Android source or QA
  builds, pairing, phone-only/on-device paths, and no public store URL. The
  page labels mobile distribution accordingly.

## Evidence captures

The four Supervisor captures in `dist/assets/evidence/` came from the existing
repository verification run dated 2026-11-11. They show a test fixture named
`onboarding-example`; no API keys are visible. They are historical product
evidence, not a claim about the state of a fresh install. The page also calls
out that a fresh Supervisor starts empty until the user opts in and selects a
project.

## Competitor comparison

Official pages checked:

- T3 Code: <https://t3.codes/> — presented as a control plane / workspace for
  coding agents and names Claude Code, Codex, Cursor, OpenCode, Grok, and
  Antigravity.
- OpenClaw: <https://openclaw.ai/> — presented as a personal agent across
  channels, with product, install, and resources navigation.
- Hermes Agent: <https://hermes-agent.nousresearch.com/> — presented as a
  free/open-source agent with memory and skills and desktop downloads.

The page uses task descriptions rather than claims of exclusivity. Each
competitor row links to its official page so readers can verify current scope.
