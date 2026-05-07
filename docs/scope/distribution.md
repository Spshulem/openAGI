# Distribution scope — Mac, Linux, SBC, Docker

What it would take to ship OpenAGI as a packaged install across platforms — Mac (`.dmg` with auto-update, menubar tray), Linux (`.deb`, AppImage, Docker), and Linux SBC (Raspberry Pi, pamir.ai-class boxes via arm64 Docker / pre-built systemd image).

The runtime is done. This scope is the **packaging, install, onboarding, and update** layer that wraps it for each platform.

## Goals

A user picks the install option that fits their environment:

| Platform | Method | Time to running |
|---|---|---|
| **Mac mini** | Drag `.dmg` → Applications. Wizard collects keys, agent starts. Auto-updates. | <5 min |
| **Linux desktop / server** | `apt install openagi` or run AppImage. systemd service starts daemon. | <5 min |
| **Linux SBC (Raspberry Pi / pamir.ai)** | Flash image OR `docker run openagi/openagi`. Setup wizard at `:43210/setup`. | <10 min |
| **Anywhere with Docker** | `docker run -p 43210:43210 -v openagi-data:/data openagi/openagi` | <2 min |

No terminal coding, no `git`, no `node`, no manual `.env` editing — except for the bare-Docker users who get the volume-mount path.

---

## Reading order

1. **Cross-platform foundation** — works on Mac AND Linux:
   - C1 Web setup wizard (`/setup`)
   - C2 Tunnel watcher (auto-updates `OPENAGI_PUBLIC_URL`)
   - C3 Admin pause/resume endpoints
2. **Linux distribution paths**:
   - L1 Docker image (multi-arch: amd64 + arm64)
   - L2 systemd service files
   - L3 `.deb` for Debian/Ubuntu (apt repo for auto-update)
   - L4 AppImage (single file, all distros, AppImageUpdate)
   - L5 SBC-friendly install script (pamir.ai, Raspberry Pi, Jetson)
3. **Mac distribution paths**:
   - M1 Bundled `.app` (Node + repo + Swift launcher)
   - M2 Menubar tray (SwiftUI)
   - M3 Sparkle auto-update
   - M4 Managed cloudflared tunnel
4. **Release infrastructure**:
   - R1 Code signing + notarization (Mac), GPG signing (apt repo)
   - R2 GitHub Actions release pipeline (multi-arch matrix)
   - R3 Distribution channels: GitHub Releases, Docker Hub, apt repo, AppImageHub, Homebrew cask

---

## Cross-platform foundation (works everywhere)

### C1 — Web setup wizard at `/setup` (1 day)

**Why.** A native Mac wizard is nicer than a browser, but a web wizard is **the only thing that works on Linux SBCs without a desktop**. So we build the web one first; Mac later overrides with native.

**Shape.**

- New endpoint `GET /setup`. When `OPENAGI_AUTH_TOKEN` is unset OR `.env` has no API keys, this is the only page that loads (everything else returns a redirect-to-setup).
- Six steps in a single-page wizard:
  1. Welcome
  2. Provider keys (Anthropic primary, OpenAI fallback)
  3. Auth token (auto-generated, "Copy & save")
  4. Optional: Twilio, Telegram, Rize (skippable)
  5. Tunnel: skip, cloudflared (instructions for install per OS), or "I'll handle it"
  6. Smoke test: send a "hi" through the agent, show the reply, confirm working
- `POST /setup/save` writes to `~/.openagi/.env` (or wherever `OPENAGI_DATA_DIR` points).
- Form validation, secret masking on inputs, "show/hide" toggles.

**Files.**

- `src/setup-wizard.js` — server-side handler + HTML template
- `src/hosted-interface.js` — gates routes on the wizard-complete check
- `src/file-utils.js` — atomic `.env` writer with key sanitization

**Effort.** 1 day.

**Validation.** Fresh data dir → load `:43210/` → redirected to `/setup` → fill keys → smoke test passes → wizard closes → dashboard loads with the new auth token.

### C2 — Tunnel watcher (0.5 day)

**Why.** Cloudflare quick-tunnel URLs rotate per restart. We want the daemon to detect and reflect the live URL automatically, instead of asking users to edit `.env` every time.

**Shape.**

- `src/tunnel-watcher.js`: watches the cloudflared log file (or its stdout when run as a child). Regex-extracts `https://*.trycloudflare.com`. When found:
  - Updates `OPENAGI_PUBLIC_URL` in process.env.
  - Persists to `.env` atomically.
  - Emits an SSE event so the dashboard refreshes the Channels tab.
  - Surfaces a notification: "Tunnel URL changed; update Twilio webhook to <URL>/channels/twilio/webhook" — with deep-link to Twilio console.
- Optional spawn mode: daemon can spawn cloudflared itself if `OPENAGI_TUNNEL_AUTOSTART=1` and the binary is on PATH.

**Effort.** 0.5 day.

### C3 — Admin pause/resume (0.5 day)

**Shape.** `POST /admin/pause` → sets `OPENAGI_TICKER_MS=0` in process state, stops cron. `POST /admin/resume` → reverses. `GET /admin/status` → current state. Surfaced in tray and dashboard as a "Pause Agent" toggle.

**Effort.** 0.5 day.

**Cross-platform foundation total: ~2 days.**

---

## Linux distribution

### L1 — Docker image (1 day)

**Why.** Universal Linux installer. Works on any host, any distro, any architecture. The single most useful artifact for SBCs and self-hosters.

**Shape.**

- Multi-stage `Dockerfile`:
  - Stage 1: `node:22-alpine` base, copies repo, runs `npm test` to validate.
  - Stage 2: minimal runtime image, copies only `src/`, `examples/`, `package.json`. Non-root user. `EXPOSE 43210`. Volume `/data`.
- `docker-compose.yml` example:
  ```yaml
  services:
    openagi:
      image: openagi/openagi:latest
      ports: ["43210:43210"]
      volumes: ["openagi-data:/data"]
      environment:
        OPENAGI_DATA_DIR: /data
        OPENAGI_AUTH_TOKEN: ${OPENAGI_AUTH_TOKEN}
        ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      restart: unless-stopped
  ```
- Multi-arch buildx: `linux/amd64` + `linux/arm64` (covers x86 servers AND Raspberry Pi 4/5 / pamir.ai / Jetson).
- Auto-publish to Docker Hub on tag push via GitHub Actions.
- Image size target: <100MB.

**Files.**

- `Dockerfile`
- `.dockerignore`
- `docker-compose.example.yml`
- `.github/workflows/docker.yml`

**Effort.** 1 day. Real work: getting buildx multi-arch working in Actions.

**Validation.** `docker run --rm -p 43210:43210 openagi/openagi` on three machines: x86 Linux, M-series Mac (Docker Desktop), Raspberry Pi 4 — all serve the wizard, accept keys, run an agent turn.

### L2 — systemd service files (0.5 day)

**Shape.**

- `scripts/install-systemd.sh`: detects if it's running as root → installs `/etc/systemd/system/openagi.service`. Else installs `~/.config/systemd/user/openagi.service` (rootless).
- Service unit:
  ```ini
  [Unit]
  Description=OpenAGI agent host
  After=network-online.target

  [Service]
  ExecStart=/usr/bin/node /opt/openagi/examples/hosted-server.js
  EnvironmentFile=/opt/openagi/.openagi/.env
  Restart=on-failure
  RestartSec=10s
  WorkingDirectory=/opt/openagi
  User=openagi

  [Install]
  WantedBy=multi-user.target
  ```
- A second optional unit `openagi-tunnel.service` for cloudflared.
- `scripts/install-systemd.sh uninstall` to remove cleanly.

**Effort.** 0.5 day.

### L3 — `.deb` package (1.5 days)

**Why.** `apt install openagi` is the cleanest Linux install path. Bonus: apt handles auto-update natively.

**Shape.**

- Use `dh_make` + `debhelper` to build the package structure.
- `debian/control`: depends on `nodejs (>= 22)`. Suggests `cloudflared`.
- `debian/postinst`: creates `openagi` user, installs systemd unit, enables it.
- `debian/prerm`: stops + disables service.
- Built artifacts: `openagi_0.1.0_arm64.deb` and `openagi_0.1.0_amd64.deb`.
- Publish to a self-hosted apt repo (GitHub Pages with `aptly` or `reprepro`) so users add a single repo + GPG key, then `apt update && apt install openagi`. Updates flow through `apt upgrade`.

**Files.**

- `debian/` directory at repo root
- `scripts/build-deb.sh`
- `.github/workflows/deb.yml` (builds + publishes to gh-pages branch)

**Effort.** 1.5 days. Most of it is the apt repo + GPG signing setup the first time.

### L4 — AppImage (1 day)

**Why.** Single-file Linux executable. Works on any distro from 2018+. No install, no root. Useful for users on niche distros (Arch, NixOS, immutable Fedora) where `.deb` doesn't help.

**Shape.**

- Use `linuxdeploy` + `appimagetool`.
- Bundle Node 22 binary + repo source.
- `OpenAGI.AppImage` runs the daemon, exposes `:43210`.
- `AppImageUpdate` tool reads embedded update info → checks GitHub Releases → downloads delta → applies. User runs the AppImage, it self-updates on next launch.

**Effort.** 1 day.

### L5 — SBC install script (0.5 day)

**Why.** pamir.ai-class boxes (and Raspberry Pi / Jetson Nano / Orange Pi) want a one-line bring-up.

**Shape.**

```bash
curl -fsSL https://openagi.dev/install.sh | sh
```

This script:

1. Detects OS + arch (Debian/Ubuntu/Raspberry Pi OS/Armbian common).
2. Installs Node 22 if missing (via NodeSource apt repo).
3. Picks the install method:
   - If Docker is present: `docker run` with persistent volume + systemd unit that wraps the docker run.
   - Else: clones the repo to `/opt/openagi`, runs `scripts/install-systemd.sh`.
4. Prints the public IP + setup URL: `http://<ip>:43210/setup`.

For pamir.ai or similar pre-imaged SBCs, the seller can preinstall this and ship boxes with OpenAGI running out of the box.

**Effort.** 0.5 day.

**Linux total: ~4.5 days.**

---

## Mac distribution

### M1 — App bundle (1.5 days)

**Goal.** A `.app` directory you can double-click. Inside: bundled Node, the OpenAGI source, and a thin Swift launcher.

**Approach.**

- Bundle Node 22 binary inside `OpenAGI.app/Contents/Resources/node/`.
- Bundle the repo source under `Resources/openAGI/`.
- Tiny Swift launcher in `Contents/MacOS/OpenAGI`:
  - Picks user data dir at `~/Library/Application Support/OpenAGI/`.
  - Sets `OPENAGI_DATA_DIR` to that path.
  - Spawns `node Resources/openAGI/examples/hosted-server.js`.
- `LSUIElement=YES` (no Dock icon — menubar only).
- Universal binary (arm64 + x86_64). Drop Intel only if size matters.

**Files.**

- `mac/OpenAGI.xcodeproj`
- `mac/OpenAGI/Launcher.swift`
- `mac/Info.plist`
- `scripts/build-app.sh`

**Effort.** 1.5 days.

### M2 — Menubar tray (2–3 days)

SwiftUI `MenuBarExtra` (macOS 13+). Status icon colour from `/audit`. Menu: Open Dashboard, Recent activity, Pause/Resume, Today's spend, Open audit, Settings, Quit. Live notifications via SSE.

**Effort.** 2–3 days.

### M3 — Sparkle auto-update (1 day)

[Sparkle](https://sparkle-project.org) wired to `appcast.xml` served from GitHub Releases. EdDSA-signed updates. Daily check, one-click apply.

**Effort.** 1 day.

### M4 — Managed cloudflared tunnel (0.5 day)

Second launchd plist for cloudflared. Tunnel watcher (C2) auto-updates `OPENAGI_PUBLIC_URL`. Tray surfaces live URL + "update Twilio webhook" deep-link.

**Effort.** 0.5 day.

**Mac total: ~5 days.**

---

## Release infrastructure

### R1 — Signing (1 day)

| Platform | What | Cost |
|---|---|---|
| Mac | Apple Developer ID + notarization (`xcrun notarytool`) | $99/yr |
| Mac (Sparkle) | EdDSA signing key for updates | free |
| Linux apt | GPG key for repo metadata | free |
| Docker | Docker Hub publish credentials | free |
| AppImage | optional GPG signing | free |

### R2 — GitHub Actions release pipeline (1.5 days)

Single workflow triggered by tag push. Matrix builds:

```yaml
strategy:
  matrix:
    include:
      - { os: macos-14,    target: dmg-arm64 }
      - { os: macos-13,    target: dmg-universal }
      - { os: ubuntu-22.04, target: deb-amd64 }
      - { os: ubuntu-22.04, target: deb-arm64,  cross: true }
      - { os: ubuntu-22.04, target: appimage-amd64 }
      - { os: ubuntu-22.04, target: docker-multiarch }
```

Outputs uploaded to the GitHub Release; apt repo updated; Docker Hub pushed; appcast.xml regenerated.

**Effort.** 1.5 days the first time, ~minutes per release after.

### R3 — Distribution channels (0.5 day)

- **GitHub Releases**: canonical artifact host for all formats.
- **Docker Hub**: `openagi/openagi:latest`, `:0.x`, `:arm64`, `:amd64`.
- **Apt repo**: `https://apt.openagi.dev/` (GH Pages + aptly), instructions in README.
- **Homebrew cask** (Mac, optional): submit one YAML to homebrew-cask after first stable release.
- **AppImageHub** (optional): submit AppImage to the catalog.

**Effort.** 0.5 day.

**Release infrastructure total: ~3 days.**

---

## Totals

| Path | Dev-days | What you ship |
|---|---|---|
| **Cross-platform minimum (Linux + Docker only)** | **3.5–4** | C1+C2+C3 + L1+L2 — Docker image, systemd, web wizard. Mac users `git clone` + run, Linux users have full install. |
| **Universal foundation (no Mac native)** | **6.5–7** | Cross-platform + L1–L5 + R2 — Docker, .deb, AppImage, SBC script, CI pipeline. Mac still uses the Linux-style "git clone" path or runs the bare daemon. |
| **Universal + Mac native** | **11.5–12** | Above + M1–M4 — adds .dmg, tray, Sparkle, managed tunnel. |
| **Universal + Mac native + polished release** | **13–14** | Adds R1+R3 — code signing, multi-arch CI matrix, distribution to all channels including Homebrew cask. |

## Recommended sequence for one engineer

1. **Cross-platform foundation (2 days)** — C1+C2+C3. Web setup wizard works for Mac users too as v0 onboarding, until M1+M2+M3 ship.
2. **Linux Docker + systemd (1.5 days)** — L1+L2. Unblocks pamir.ai class SBCs and any self-hoster. Single biggest leverage outside Mac.
3. **Mac .app + Sparkle (2.5 days)** — M1+M3. Makes the Mac mini "double-click and go" without yet building the tray. Auto-update from day one.
4. **GitHub Actions release pipeline (1.5 days)** — R2. After this, every git tag produces signed artifacts on every platform.
5. **Mac menubar tray (2–3 days)** — M2. Polish.
6. **Linux .deb + AppImage (2 days)** — L3+L4. Catches up Linux UX to Mac.
7. **SBC install script + Homebrew cask (1 day)** — L5+R3.

This way, every checkpoint produces something distributable.

## Risks that span the whole scope

- **Apple Developer ID maintenance** — $99/year, single point of failure for Mac builds. Notarization breaks if it lapses.
- **Sparkle EdDSA key loss** — can't ship updates to existing Mac installs. Treat like a code-signing cert.
- **GPG key for apt repo** — same risk for Linux. Loss = users can't update via apt.
- **Cross-arch CI cost** — multi-arch Docker buildx in GH Actions is slow; expect 15–25 min per release. Acceptable.
- **Platform drift** — macOS Ventura requirement for SwiftUI MenuBarExtra. Linux glibc requirements for AppImage (target glibc 2.28+). Document supported floors.
- **Tunnel URL rotation** (Cloudflare quick-tunnel) — same problem on every platform. C2 watcher mitigates but doesn't eliminate.

## What this scope deliberately does not cover

- **Windows.** Out of scope. The Claw projects don't target it either; if needed later, follow Electron + WiX path.
- **iOS / Android companion apps.** Dashboard is mobile-friendly via browser.
- **Multi-tenant SaaS / cloud-hosted OpenAGI.** Single-machine, single-user assumption holds.
- **Cloud sync of `.openagi/`** — back up the directory yourself if you want it.

## Bottom line

- Cheapest credible **multi-platform** distribution: **3.5–4 dev-days** (Docker + systemd + web wizard). Pamir.ai-class boxes work after this.
- Cheapest **Mac+Linux native** distribution: **11.5–12 dev-days**.
- Fully polished cross-channel release: **13–14 dev-days**.

The runtime is a fixed cost; the packaging is amortized — each platform is 1–2 days of independent work. Pick the platforms that match your user base.
