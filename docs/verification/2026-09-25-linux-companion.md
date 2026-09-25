# Linux companion acceptance — 2026-09-25

## Scope

This record covers the Linux companion introduced on top of OpenAGI `v0.0.26`
(`49790c98becdb7cf0c7802d0fa82c8ae3e022324`). The reviewed implementation
baseline was `0cfb21e0be187a0d246ad372d06d8b66b454597f`; subsequent documentation-only
commits do not alter that runtime candidate.

The companion preserves the existing Node daemon and browser dashboard while
adding a native PySide6 tray, Quick Ask, KWin focus bridge, XDG Portal capture,
local OCR, observations, and approval-gated Computer Use.

## Verified platform boundary

Live acceptance was performed on:

- Fedora 44, x86-64;
- KDE Plasma 6 / KWin 6.7.5;
- Wayland;
- Python 3.14 and Node.js 22.23.2;
- Tesseract 5.5.3;
- user systemd services.

This is the production-validated target. Other Linux distributions, desktop
environments, and portal implementations remain beta pending equivalent live
coverage.

## Automated evidence

The final implementation candidate produced these results:

- Linux suite on the validated desktop with the installed companion stopped:
  101 passed, 0 failed;
- documentation closeout with the installed companion active: 100 passed,
  1 explicit D-Bus-name ownership skip, 0 failed;
- Ubuntu 24.04 workflow-equivalent clean container: 97 passed, 0 failed;
- Node suite: 1,209 passed, 1 skipped, 0 failed;
- `npm audit --omit=dev`: 0 vulnerabilities;
- Python AST parse: 63 files;
- `git diff --check`: passed;
- `bash -n linux/install-user.sh`: passed;
- `node --check linux/kwin/contents/code/main.js`: passed.

The Linux suite includes deterministic regressions for:

- browser-hosted sensitive-title exclusions;
- pre- and post-frame privacy checks;
- bounded RPC concurrency and idle-client isolation;
- RPC shutdown linearization, cancellation, and socket/worker drainage;
- activation and post-start-health rollback;
- restoration of entrypoints, units, drop-ins, desktop/KWin files, `kwinrc`,
  and prior enabled/active service state;
- real Qt object construction and event-loop shutdown;
- installed D-Bus-name conflict handling in the application smoke test.

## Live desktop evidence

The following paths were exercised against the real KDE/Wayland desktop rather
than inferred from unit tests:

- tray registration through StatusNotifierItem;
- KWin script installation and the `OpenAGI Quick Ask` global shortcut;
- Quick Ask request/response using the existing Node endpoint;
- independent ScreenCast consent, PipeWire frame acquisition, crop, local
  Tesseract OCR, and observation delivery;
- independent RemoteDesktop consent, screenshot readiness, cursor mapping, and
  a harmless pointer movement;
- an approval-gated Computer Use task through Node, helper, Unix RPC, and portal
  input with the result observed;
- revocation and restart with screenshot and input readiness disabled;
- installed-service restart with no warnings, coredumps, or automatic restarts;
- multiple simultaneous idle RPC clients without blocking a legitimate health
  request.

No commercial model provider was consumed for this acceptance run; the Quick
Ask and Computer Use checks used a deterministic local provider.

## Privacy and lifecycle disposition

- ScreenCast and RemoteDesktop remain separate, opt-in permissions and are off
  by default.
- Observation screenshots are not persisted or uploaded; only OCR text and
  minimal metadata enter the observation path.
- Computer Use screenshots use the separate approved control path and may enter
  the configured model context as documented in `linux/README.md`.
- RPC effects require peer credentials plus the configured
  `openagi.service` cgroup origin.
- Shutdown blocks new registrations, cancels active contexts, and drains tracked
  connections and workers before reporting closed.
- The rootless installer uses staged versioned releases and restores the prior
  installation and service state if activation or health validation fails.

## Exclusions

- iMessage and other Apple-only integrations are not ported.
- No claim is made for X11, non-KDE portals, or universal Linux support.
- Local credentials, portal tokens, installed releases, evidence bundles, and
  workspace artifacts are not part of the repository candidate.
- Commercial use remains subject to the repository's PolyForm Noncommercial
  1.0.0 license.
