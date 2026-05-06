# Distribution scope — from `git clone` to "double-click to install"

What it would take to ship OpenAGI as a packaged Mac app the way OpenClaw, PicoClaw, and TinyAGI ship — `.dmg`, drag-to-Applications, menubar tray, native onboarding, auto-update, signed and notarized.

The runtime is done. This scope is purely the **packaging, install, onboarding, and update** layer that wraps it.

## Goal

A non-technical user can:

1. Download `OpenAGI-0.x.dmg` from a release page.
2. Drag the app to Applications.
3. Open it once. A wizard collects API keys, asks if they want SMS/tunnel, and verifies the agent works.
4. From then on it lives in the menubar, auto-restarts on crash, auto-updates weekly, and the dashboard opens with one click.

No terminal, no `git`, no `node`, no `npm`, no editing `.env`.

---

## Reading order

1. **Phase 1 — App bundle.** Wrap the Node runtime + repo into a single signed `.app`.
2. **Phase 2 — Menubar tray.** Native Swift status item with status, quick actions, notifications.
3. **Phase 3 — First-run wizard.** Native SwiftUI onboarding that writes `.env` and tests the agent.
4. **Phase 4 — Auto-update.** Sparkle-based update channel from GitHub Releases.
5. **Phase 5 — Managed tunnel.** Cloudflared as a second launchd job, controlled from the tray.
6. **Phase 6 — Distribution.** Sign, notarize, .dmg, GitHub Actions release pipeline, optional Homebrew cask.

---

## Phase 1 — App bundle (1–1.5 days)

**Goal.** A `.app` directory you can double-click. Inside: bundled Node runtime, the OpenAGI source, and a thin launcher.

**Approach.**

- Bundle Node 22 binary inside `OpenAGI.app/Contents/Resources/node/`.
- Bundle the repo source under `Resources/openAGI/` (just the runtime files; no `.openagi/` or `.git/`).
- Tiny Swift launcher in `Contents/MacOS/OpenAGI` that:
  - Picks a writable user data dir (`~/Library/Application Support/OpenAGI/`).
  - Sets `OPENAGI_DATA_DIR` to that path.
  - Spawns `node Resources/openAGI/examples/hosted-server.js`.
  - Exposes a no-op window so launchd treats it as an app.
- Keep `npm run install-launchd` flow as the headless / power-user path; the `.app` itself **is** the launchd-equivalent for GUI installs.

**Files.**

- `mac/OpenAGI.xcodeproj` (Swift Package or Xcode project)
- `mac/OpenAGI/Launcher.swift`
- `mac/Info.plist` with `LSUIElement=YES` (no Dock icon — menubar only)
- `scripts/build-app.sh` — assembles the bundle, copies node binary, syncs source
- `.github/workflows/build-mac.yml` (in Phase 6)

**Effort.** 1–1.5 days.

**Risks.**

- Apple Silicon vs Intel: ship a universal binary or two separate dmgs. Bundling the Node binary doubles size if universal. Mitigation: ship arm64-only first, drop x86 unless someone asks.
- App Sandbox vs networking — keep sandbox **off** for v1 (we run a daemon and spawn child MCP processes). Hardened Runtime stays on for notarization.
- Bundle size: Node arm64 binary is ~85MB. App size lands at ~110MB. Acceptable but not tiny.

**Validation.** Drag `.app` to Applications, double-click, hit `http://127.0.0.1:43210/health` and get 200.

---

## Phase 2 — Menubar tray (2–3 days)

**Goal.** A tiny menubar item that shows daemon health and gives one-click access to common actions. No Dock icon.

**Approach.**

Native SwiftUI `MenuBarExtra` (macOS 13+). Status icon is the OpenAGI mark; colour reflects health:

- green: daemon online, budget < 70%, last 7-day quality > 0.5
- yellow: budget > 70% **or** outcome quality < 0.5 **or** dormant specialists detected
- red: daemon down, or budget hit, or hardline finding from `/audit`

**Menu items.**

- Open Dashboard (opens `http://127.0.0.1:43210/?token=…` in default browser)
- Recent activity (last 5 sessions, click to open that thread)
- Pause Agent / Resume Agent (toggles `OPENAGI_TICKER_MS=0` via `/admin/pause`)
- Today's spend: `$X / $Y`
- Open audit (opens `/audit` view)
- Settings… (opens Phase 3 wizard for re-config)
- Quit OpenAGI (cleanly stops launchd via `launchctl bootout`)

**Live notifications via SSE.** The tray subscribes to `/events` and surfaces:

- Autopilot pulse made an outbound action (sent SMS, scheduled job, retired specialist)
- Budget crossed 70% / 90% of daily cap
- Scrutiny fitter has a pending proposal awaiting review (during warmup)

User taps the notification → dashboard opens to the relevant tab.

**Files.**

- `mac/OpenAGI/TrayController.swift`
- `mac/OpenAGI/HealthPoller.swift`
- `mac/OpenAGI/SSEClient.swift`
- `src/hosted-interface.js` adds `POST /admin/pause` and `POST /admin/resume`

**Effort.** 2–3 days. Most of it is polish (icons, notifications copy, reconnect logic on SSE drop).

**Validation.** Quit/reopen, verify state survives. Pause via tray and confirm cron stops firing. Trigger a budget threshold and confirm notification fires.

---

## Phase 3 — First-run wizard (1–2 days)

**Goal.** Native SwiftUI window that walks the user through the only manual step left: dropping in keys.

**Approach.**

The launcher checks for `~/Library/Application Support/OpenAGI/.env`. If absent or empty, blocks the daemon start, opens the wizard, and only starts the daemon after the user finishes (or skips) onboarding.

**Steps.**

1. **Welcome.** What this is, what it'll do, "you can change all of this later in Settings."
2. **Provider key.** Anthropic API key field with a "Get a key" link. Skip allowed (deterministic mode).
3. **Auth token.** Auto-generated bearer token shown once with a "Copy & Save" button. Wizard sets `OPENAGI_AUTH_TOKEN` so the dashboard is locked from step one.
4. **Optional integrations.** Three checkboxes:
   - Twilio SMS (opens fields if checked)
   - Telegram (token field)
   - Rize.io (key field)
5. **Tunnel.** Three options: "Skip", "Cloudflare (auto-install with Homebrew)", "ngrok (auto-install)". The wizard runs the install in the background and shows progress.
6. **Test it.** Sends a real "hi" through `POST /message`, shows the agent's reply. If it fails, surface the error and offer "Retry / Open dashboard / Skip."
7. **Done.** Closes wizard; tray comes alive; dashboard opens automatically the first time.

**Files.**

- `mac/OpenAGI/OnboardingWindow.swift`
- `mac/OpenAGI/Steps/*.swift` (one per step)
- `mac/OpenAGI/EnvWriter.swift` (atomic write to `.env`)

**Effort.** 1–2 days. The Twilio/Telegram setup screens involve 4 fields each; the tunnel auto-install is the only non-trivial step.

**Risks.** Homebrew may not be installed. Detect and fall back to instructions ("Install Homebrew first, or skip and we'll work without a public URL").

**Validation.** Fresh user run (delete `~/Library/Application Support/OpenAGI/`), wizard opens, every path completes successfully.

---

## Phase 4 — Auto-update (1 day)

**Goal.** OpenAGI updates itself silently from GitHub Releases.

**Approach.**

[Sparkle](https://sparkle-project.org), the standard Mac update framework. Sparkle reads an `appcast.xml` feed; GitHub Releases can serve one.

**Wire-up.**

- Generate `appcast.xml` as part of release build (Sparkle has a tool for this).
- Tray adds "Check for Updates…" menu item.
- Default policy: check daily, prompt for restart with one-click apply (or Settings option to enable fully silent updates).
- Updates run as the user — no admin password.

**Cryptographic signing for updates** uses the EdDSA signing keys Sparkle generates; you sign each release `.dmg`, Sparkle verifies before applying.

**Files.**

- `mac/OpenAGI/UpdateController.swift`
- `mac/Sparkle.framework` (vendored)
- `scripts/release.sh` — builds, signs, generates appcast entry, uploads to GH Release

**Effort.** 1 day (after the first signed release in Phase 6).

**Risks.** Lose your Sparkle EdDSA key, you can't ship updates that existing installs trust. Mitigation: store the key in 1Password + a print backup.

**Validation.** Install v0.1, push v0.2, app prompts within an hour, restart applies.

---

## Phase 5 — Managed tunnel (0.5 day)

**Goal.** The tunnel runs as a managed service the user doesn't think about. The dashboard's Channels tab shows a live URL. Tray turns green when the tunnel is up.

**Approach.**

A second launchd plist for cloudflared with `KeepAlive=true`. The wizard's tunnel step writes it. cloudflared logs to `~/Library/Application Support/OpenAGI/tunnel.log`.

The OpenAGI daemon watches the tunnel log, parses out the public URL, **auto-updates `OPENAGI_PUBLIC_URL`** in `.env`, and signals `SIGHUP` to itself to reload.

Tray menu adds:

- Tunnel: ✓ live · `https://abc.trycloudflare.com` (click to copy)
- Restart Tunnel
- Open Twilio webhook setup (deep-link to console.twilio.com with the URL pre-filled in pasteboard)

**Files.**

- `scripts/install-tunnel-launchd.sh`
- `src/tunnel-watcher.js` (watches the log, reloads env)
- `mac/OpenAGI/TunnelStatus.swift`

**Effort.** 0.5 day.

**Risks.** cloudflared quick-tunnel URL changes per restart, which means Twilio webhook also changes. Two ways out:
- (a) Add a "your URL changed; update Twilio?" notification with one-click copy.
- (b) Push the user to set up a named Cloudflare Tunnel against their own domain — the wizard could do this if they sign in to Cloudflare from the wizard, but that's a Phase 7 stretch.

For v1, ship (a). It's annoying but honest.

**Validation.** Restart the Mac. Daemon comes up, tunnel comes up, public URL is set, Twilio webhook still works (or notification fires telling user to update it).

---

## Phase 6 — Distribution (1–2 days, mostly first-time setup)

**Goal.** Reproducible signed release pipeline.

**Mechanics.**

| Item | What |
|---|---|
| Apple Developer ID | $99/year. You upload the cert to GitHub Actions secrets. |
| Hardened Runtime + Notarization | Required for Gatekeeper to be quiet. `xcrun notarytool submit --wait`. |
| Code signing | `codesign --deep` on the bundle, including the Node binary. |
| `.dmg` build | `create-dmg` (Homebrew) or `dmgbuild` produces a drag-to-Applications dmg with a custom background. |
| GitHub Release | Tag → workflow runs → uploads `.dmg` + `appcast.xml` entry. |
| Homebrew cask (optional) | One YAML file in homebrew-cask. `brew install --cask openagi`. Submit a PR after first successful release. |

**Files.**

- `.github/workflows/release.yml`
- `scripts/release.sh`
- `mac/Resources/dmg-background.png`
- `Casks/openagi.rb` (in a separate `homebrew-openagi` tap)

**Effort.** 1–2 days the first time; ~5 min per subsequent release.

**Risks.**

- Notarization can fail for opaque reasons. Budget extra debugging time on the first run.
- If you want users on Intel Macs, add `arm64+x86_64` in the workflow matrix (doubles build time, doubles dmg size).

**Validation.** Download from release page on a clean Mac → drag to Applications → first launch succeeds without Gatekeeper warnings.

---

## Totals

| Path | Dev-days | What you ship |
|---|---|---|
| **Minimum viable distribution** | **3–4** | Phase 1 + Phase 6 — drag-to-Applications app, signed and notarized, no tray, no wizard, drops user into a browser dashboard with a default-generated auth token in a known location |
| **OpenClaw-equivalent UX** | **7–10** | All six phases. Tray, wizard, auto-update, managed tunnel |
| **Polished + Homebrew cask + analytics** | **10–13** | Add CI/CD release flow, opt-in usage telemetry (privacy-first, local-only), cask submission |

## Recommended sequence for one engineer

1. **Phase 1 + Phase 6 (3–4 days)** — get a signed `.dmg` out the door first. Even without a tray or wizard, it's installable, persistent, and survives reboots. Distribute to early users. Real feedback steers Phase 2/3 priorities.
2. **Phase 2 (2–3 days)** — tray, after you know what users actually click on.
3. **Phase 3 (1–2 days)** — wizard, last because by then you've seen which env-config questions actually trip people up.
4. **Phase 4 (1 day)** — Sparkle once Phase 6 release pipeline is stable.
5. **Phase 5 (0.5 day)** — managed tunnel parallel-tracks anywhere after Phase 1.

## Risks that span the whole scope

- **Apple Developer ID maintenance.** $99/year, single point of failure. If it lapses, builds stop notarizing.
- **macOS version drift.** SwiftUI MenuBarExtra requires Ventura+. You'd lose Big Sur and Monterey users. Acceptable; almost no Mac mini buyer is on those.
- **Privacy posture.** Bundling Node + spawning child processes means the app needs `com.apple.security.cs.allow-jit` or hardened runtime exceptions. Document carefully so notarization passes consistently.
- **Cloudflare quick-tunnel URL rotation.** The honest answer is "set up a real tunnel against your own domain" but that's a wizard step too far. v1 lives with the rotation + one-tap "update Twilio webhook" notification.
- **Update signing key.** Lose the Sparkle EdDSA private key and you can't push updates. Treat like a code-signing cert.
- **Cross-architecture support.** Universal binary doubles size; arm64-only halves your TAM (still covers all M1+ machines, which is most Mac mini sales since 2020).

## What this scope deliberately does not cover

- Windows / Linux distribution. macOS only by design — same posture as the Claw projects.
- Mobile companion app. The dashboard is mobile-friendly already (modulo the responsive breakpoint gap).
- Payment integration / monetization. OpenAGI itself is open-source; the Mac mini buyer is the user.
- Cloud sync of `.openagi/`. Single-machine assumption holds.
- Multi-user on one Mac. Single-user assumption.

## Bottom line

Cheapest credible "OpenClaw-class" distribution: **7–10 dev-days** for one engineer. The minimum credible installable: **3–4 days**. Everything beyond Phase 1 is UX polish over a runtime that's already complete.
