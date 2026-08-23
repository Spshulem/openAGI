# OpenAGI · Mac native app

A SwiftUI menubar app that bundles Node 22 + the OpenAGI runtime, manages the daemon as a child process, and self-updates via Sparkle.

## What's here

```
mac/
├── Package.swift                 # SwiftPM with Sparkle dependency
├── Sources/OpenAGI/
│   ├── OpenAGIApp.swift          # @main, MenuBarExtra
│   ├── AppDelegate.swift         # NSApp lifecycle, notifications
│   ├── AppState.swift            # ObservableObject — health, sessions, budget, findings
│   ├── DaemonController.swift    # Spawns + supervises the Node child process
│   ├── TrayController.swift      # MenuBarExtra menu items
│   ├── SSEDelegate.swift         # /events stream → notifications
│   └── UpdateController.swift    # Sparkle wrapper
└── Resources/
    ├── Info.plist                # LSUIElement=YES, SUFeedURL, SUPublicEDKey placeholders
    └── entitlements.plist        # Hardened runtime exceptions for child processes
```

The build script lives at the repo root: [`scripts/build-mac-app.sh`](../scripts/build-mac-app.sh).

## Build

Requires Xcode command line tools (`xcode-select --install`).

```bash
./scripts/build-mac-app.sh                       # release build, no signing
SIGN_IDENTITY="Developer ID Application: ..." ./scripts/build-mac-app.sh
SIGN_IDENTITY="..." NOTARIZE=1 DMG=1 \
  AC_USERNAME=you@example.com AC_PASSWORD=app-specific AC_TEAM_ID=TEAMID \
  ./scripts/build-mac-app.sh
```

Output: `build/OpenAGI.app` (and `build/OpenAGI-<version>.dmg` when `DMG=1`).

## Sparkle setup (auto-update)

One-time, before your first signed release:

```bash
# Generate an EdDSA keypair (keep the private key safe — use 1Password)
brew install sparkle
generate_keys                    # prints public key + writes private key
```

Update `mac/Resources/Info.plist`:

- Replace `__SPARKLE_PUBLIC_KEY__` with the public key string
- Set `SUFeedURL` to the appcast URL you'll publish (default points at GitHub Releases)

When you build a new release:

1. Sign + notarize the `.dmg` (the build script does this when `SIGN_IDENTITY` and `NOTARIZE=1` are set).
2. Sign the `.dmg` with your Sparkle EdDSA key:
   ```bash
   sign_update build/OpenAGI-0.x.dmg
   ```
3. Append a new entry to `appcast.xml` and upload it alongside the `.dmg` to GitHub Releases.

Fresh signed installs check daily and install/restart automatically so unattended nodes do not remain on an incompatible version. Users can disable automatic checks or automatic installation from the menu-bar **Updates** submenu; Sparkle persists that explicit choice across later releases. Existing installs that previously opted out remain opted out.

## How it runs

On launch the app:

1. Sets `NSApp.setActivationPolicy(.accessory)` — no Dock icon, only the menubar.
2. Spawns `Contents/Resources/node/bin/node Contents/Resources/openAGI/examples/hosted-server.js`, with `OPENAGI_DATA_DIR=~/Library/Application Support/OpenAGI/`.
3. Polls `http://127.0.0.1:43210/health`, `/budget`, `/audit`, `/sessions` every 5s.
4. Subscribes to `/events` SSE for live notifications.
5. Runs Sparkle's daily update check.

The first run shows the dashboard's web wizard at `http://127.0.0.1:43210/setup` — same wizard the Linux/Docker installs use. Once the user fills in keys and the smoke test passes, the wizard closes and the menubar comes alive with health.

## Quit behavior

Quit from the tray menu (or `Cmd-Q`) terminates the Node child cleanly via `Process.terminate()`, then `SIGKILL` after 3s if still alive.

## What's not here yet (and is out of scope for v1)

- A native settings window — Settings menu opens the web wizard. Good enough for v1.
- Multi-instance support (running two OpenAGI apps on one machine) — assume single user.
- Cocoa-style preferences sync — env file is the source of truth.

## Troubleshooting

**"Cannot find module" when launching the app:** the build script didn't copy `src/` and `examples/` into `Contents/Resources/openAGI/`. Re-run the build, check rsync output.

**App quits immediately:** Console.app → filter for "OpenAGI" — usually means the bundled Node binary couldn't execute (signing/notarization issue). Inspect `~/Library/Application Support/OpenAGI/daemon.log`.

**Sparkle update never appears:** the app's `SUPublicEDKey` doesn't match the key the release was signed with. Either re-sign or rebuild with the correct public key.
