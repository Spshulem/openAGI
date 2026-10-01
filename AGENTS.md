# Contributor guidance

This file applies to the entire repository. A more specific `AGENTS.md` in a
subdirectory takes precedence for that subtree.

## Repository shape

- `src/` and `examples/hosted-server.js` are the canonical Node runtime and web
  interface.
- `mac/` is the native macOS application.
- `linux/` is an additive PySide6 companion for KDE Plasma on Wayland. It must
  adapt to the existing HTTP, observation, approval, lease, and Computer Use
  contracts; do not create a parallel agent API or state model.
- `test/` contains Node tests. `linux/tests/` contains Linux unit, contract,
  packaging, lifecycle, and opt-in live-environment tests.
- `docs/verification/` records dated evidence. Keep claims bounded to what was
  actually exercised.

## General changes

- Read the implementation, its tests, and the relevant documentation before
  editing. Trace existing contracts instead of inventing replacements.
- Keep changes focused. Do not reformat or rename unrelated code.
- Preserve the Node core and web dashboard unless the task explicitly requires
  a cross-platform contract change.
- Use conventional commit messages. Never commit credentials, tokens, private
  configuration, local evidence, installed releases, caches, or files under a
  local `workspace/` directory.
- OpenAGI is licensed under PolyForm Noncommercial 1.0.0. Do not imply that the
  repository grants commercial-use rights.

## Linux support boundary

The production-validated Linux target is Fedora 44, x86-64, KDE Plasma 6/KWin,
Wayland, and the KDE XDG Desktop Portal. Treat other distributions, desktop
environments, and portal implementations as beta until equivalent live evidence
exists. Do not add an unreviewed X11 fallback or broaden support claims based
only on headless tests.

The Linux companion intentionally excludes iMessage and other genuinely
Apple-only integrations.

## Linux privacy and authority invariants

Changes under `linux/` or to Linux Computer Use integration must preserve all of
the following unless an explicit design change updates code, tests, and docs
together:

- ScreenCast and RemoteDesktop are disabled by default, use separate portal
  sessions, and require independent explicit consent.
- Observation frames remain in memory, go to Tesseract over stdin, and are not
  written to the observation outbox or sent as observation image bytes.
- Privacy checks run before capture and again after a frame arrives, before OCR.
  Unknown, stale, changed, or sensitive focus fails closed.
- Browser-hosted sensitive content must be evaluated using both application and
  window-title context.
- Typed text and sensitive image data must not appear in argv, logs, or
  telemetry.
- Computer Use preserves `leaseId`, `actionId`, sequence, expiry, deadline,
  fresh-frame, focus, idempotency, and cancellation from Node through the helper
  and private RPC.
- Every input effect checks cancellation immediately before execution. HTTP
  disconnects abort helper, RPC, and portal work.
- Same UID is insufficient RPC authority. Effect requests must also come from
  the configured `openagi.service` cgroup.
- RPC concurrency stays bounded. Once shutdown begins, no new connection or
  worker may register or start; shutdown must drain tracked sockets and workers.
- Focus loss, close, or minimization invalidates the previous window identity.
  Quick Ask freezes the previous application context before taking focus.
- Never report Computer Use success without an observed result.

## Installer and service invariants

- `linux/install-user.sh` remains rootless and must not install operating-system
  packages or elevate privileges.
- Build candidates outside the active release and publish through the `current`
  symlink only after preflight and validation.
- A failure during activation or post-start health must restore the previous
  release, entrypoints, unit/drop-in, desktop and KWin files, `kwinrc`, and prior
  enabled/active states.
- Keep the companion systemd sandbox and the explicit `openagi.service` trust
  boundary intact.
- Dispose Qt objects while the event loop can still process `deleteLater()`;
  avoid teardown paths that leave warnings, coredumps, or orphaned D-Bus names.

## Verification

For Node changes, run:

```bash
npm test
```

For Linux companion changes on a host with the native dependencies installed,
run:

```bash
PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen \
  python3 -m unittest discover -s linux/tests -p 'test_*.py' -v
bash -n linux/install-user.sh
node --check linux/kwin/contents/code/main.js
python3 - <<'PY'
import ast
from pathlib import Path

for path in Path("linux").rglob("*.py"):
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
PY
```

Also run `git diff --check`. Use the Ubuntu 24.04 workflow-equivalent lane for
changes to packaging, native dependencies, or CI. Portal actions that open
consent dialogs are never part of unattended tests; document live ScreenCast or
RemoteDesktop evidence separately and never simulate user consent.

Before committing, stage only intended paths, inspect the complete staged diff,
and confirm that local `workspace/`, secrets, caches, and runtime state are not
in the index.
