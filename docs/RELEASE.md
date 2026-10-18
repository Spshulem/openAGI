# Releasing OpenAGI

OpenAGI ships in four forms, released by tagging `vX.Y.Z` on `main`:

1. **Docker image** — `ghcr.io/spshulem/openagi:vX.Y.Z` + `:latest`. Built by [`docker.yml`](../.github/workflows/docker.yml). No special setup — uses `GITHUB_TOKEN`.
2. **macOS native `.app`** — codesigned + notarized + Sparkle-signed `.dmg` uploaded to the GitHub Release. Built by [`release-mac.yml`](../.github/workflows/release-mac.yml). **Requires the secrets below.**
3. **Windows / Linux portable runtime** — `OpenAGI-Windows-x64.zip`, `OpenAGI-Linux-x64.tar.gz`, and `OpenAGI-Linux-arm64.tar.gz`, each with Node.js, production dependencies, licenses, a launcher, and a `.sha256` checksum. Built by [`runtime-downloads.yml`](../.github/workflows/runtime-downloads.yml), called after the Mac release publishes. No signing secrets needed. This is the browser/CLI runtime, not a Windows/Linux native capture app.
4. **Source install** — `git clone` + `npm run serve`, or the source archives on each release.

The portable workflow tests all three runner architectures on PRs and uploads
seven-day test artifacts. On a tag release it verifies that the commit belongs
to `origin/main` and the tag matches `package.json`, then publishes downloads
only after all three packages pass. The Mac workflow calls it explicitly:
release events created with `GITHUB_TOKEN` do not trigger another workflow.
Packaging uses an explicit source allowlist and a clean `npm ci --omit=dev`;
never archive an operator checkout, `.env`, or the agent's state directory.

Keep [install availability](INSTALL.md#downloads) accurate. A successful PR
artifact is not a public GitHub release asset. Do not create a tag or overwrite
an older release merely to advertise download links.

After this guide is finished once, releasing is `git tag -a v0.0.2 -m "..." && git push origin v0.0.2`.

For a notarized test build from a branch, run the **Mac — notarized test build
or release** workflow manually. It uploads a seven-day `.app` ZIP artifact and
does not create a tag, GitHub Release, appcast, or public update. This is the
preferred way to test a branch under Gatekeeper without copying Apple account
credentials into a developer's shell.

---

## One-time setup: GitHub repository secrets

The macOS release workflow needs five secrets to sign + notarize. Go to **Repo → Settings → Secrets and variables → Actions → New repository secret** and add each.

### 1. `APPLE_DEVELOPER_ID_CERT_P12_BASE64`

Your "Developer ID Application" certificate, exported as `.p12` and base64-encoded.

```bash
# 1. In Keychain Access, find your "Developer ID Application: <Name> (<TEAM_ID>)" identity.
# 2. Right-click → Export → save as developer-id.p12, set a password.
# 3. Encode for GH:
base64 -i developer-id.p12 | pbcopy
# Paste into the GH secret. Delete developer-id.p12 after.
```

### 2. `APPLE_DEVELOPER_ID_CERT_PASSWORD`

The password you used when exporting the `.p12` above.

### 3. `APPLE_ID`

The Apple ID email associated with your developer account (e.g. `you@example.com`).

### 4. `APPLE_APP_PASSWORD`

An **app-specific password** (not your Apple ID password) used by `notarytool`.

```text
1. Go to appleid.apple.com → Sign in → App-Specific Passwords.
2. Generate one labelled "OpenAGI notarization".
3. Copy the 16-character password (xxxx-xxxx-xxxx-xxxx).
```

### 5. `APPLE_TEAM_ID`

Your 10-character Apple Developer Team ID (e.g. `3AVR8P72M4`). Find it at developer.apple.com under Membership, or in your Developer ID cert's name (`Developer ID Application: Build Better, Inc. (3AVR8P72M4)` → `3AVR8P72M4`).

### 6. `SPARKLE_ED_PRIVATE_KEY`

The EdDSA private key Sparkle uses to sign update artifacts. The matching public key is already in `mac/Resources/Info.plist`.

The key was generated locally with `mac/.build/artifacts/sparkle/Sparkle/bin/generate_keys` and stored in your macOS keychain. Export it for CI:

```bash
# Exports the base64-encoded private key. DO NOT echo this, copy directly to clipboard.
security find-generic-password -a "ed25519" -s "https://sparkle-project.org" -w | pbcopy
# Paste into the SPARKLE_ED_PRIVATE_KEY secret. The keychain copy stays for local builds.
```

If the keypair was lost or you need to regenerate (this invalidates all prior signed updates):

```bash
mac/.build/artifacts/sparkle/Sparkle/bin/generate_keys
# Update mac/Resources/Info.plist's SUPublicEDKey with the printed public key.
```

---

## Cutting a release

Once the secrets are in:

```bash
# Bump version in package.json (single source of truth)
# Then tag + push
git tag -a v0.0.2 -m "v0.0.2 — short summary"
git push origin v0.0.2
```

The Docker and Mac workflows start from the tag. The Mac workflow then calls
the portable-download workflow after publishing its assets:

| Workflow | Output | Time |
|---|---|---|
| `docker.yml` | `ghcr.io/spshulem/openagi:v0.0.2` + `:latest` (multi-arch) | ~5 min |
| `release-mac.yml` | `OpenAGI-0.0.2.dmg` + `appcast.xml` on the GitHub Release | ~15–25 min (notarization is the slow part) |
| `runtime-downloads.yml` (called by Mac release) | Windows x64 ZIP, Linux x64/arm64 tarballs, and checksums on the same release | ~3–10 min after the Mac assets publish |

When `release-mac.yml` finishes, the `.dmg` is at `https://github.com/Spshulem/openAGI/releases/download/v0.0.2/OpenAGI-0.0.2.dmg` and the appcast at `…/appcast.xml`. Existing installs see the update next time Sparkle polls (default daily).

## Notarized branch build (no release)

From GitHub Actions, select **Mac — notarized test build or release**, choose the
branch, and click **Run workflow**. From the CLI:

```bash
gh workflow run release-mac.yml --ref <branch>
```

When the run completes, download the `OpenAGI-<version>-notarized-<sha>`
artifact. Its ZIP contains a Developer ID-signed, Apple-notarized, stapled
`OpenAGI.app`. Manual branch runs never publish release assets or update the
Sparkle feed.

---

## What an install looks like for users

| Path | Command |
|---|---|
| **macOS** | `curl -fsSL openagi.sh \| sh` → auto-detects macOS → downloads latest signed `.dmg` → mounts → copies to `/Applications` → launches |
| **Linux (Debian / RPi / Armbian)** | Same `curl` line → installs Node + clones repo + sets up systemd |
| **Linux (with Docker)** | Same `curl` line → docker compose with persistent volume |
| **From source** | `git clone https://github.com/Spshulem/openAGI && cd openAGI && npm install && npm run serve` |
| **Docker (manual)** | `docker run -d -p 43210:43210 -v openagi-data:/data ghcr.io/spshulem/openagi:latest` |

---

## Manual local release (without CI)

If a CI workflow breaks or you want to ship from your laptop:

```bash
# 1. Build + sign + notarize + DMG (uses your Keychain cert)
SIGN_IDENTITY="Developer ID Application: <Name> (<TEAM>)" \
  NOTARIZE=1 DMG=1 \
  AC_USERNAME="you@example.com" \
  AC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
  AC_TEAM_ID="3AVR8P72M4" \
  ./scripts/build-mac-app.sh

# 2. Generate Sparkle appcast.xml (uses keychain private key)
DMG=build/OpenAGI-0.0.2.dmg \
  VERSION=0.0.2 \
  RELEASE_NOTES_URL="https://github.com/Spshulem/openAGI/releases/tag/v0.0.2" \
  ./scripts/generate-appcast.sh

# 3. Upload both to the GitHub release
gh release upload v0.0.2 build/OpenAGI-0.0.2.dmg build/appcast.xml --clobber
```

---

## Troubleshooting

**Notarization stuck or rejected.** Check the log:
```bash
xcrun notarytool history --apple-id "$AC_USERNAME" --password "$AC_PASSWORD" --team-id "$AC_TEAM_ID"
xcrun notarytool log <submission-id> --apple-id "$AC_USERNAME" --password "$AC_PASSWORD" --team-id "$AC_TEAM_ID"
```
Common causes: missing entitlements, unsigned dependencies inside the bundle, hardened-runtime mismatch.

**Sparkle says "Update is improperly signed."** The `SUPublicEDKey` in `Info.plist` doesn't match the private key used to sign. Either:
- The private key changed (regenerated). Update the public key in `Info.plist` to match.
- The base64 in `SPARKLE_ED_PRIVATE_KEY` got corrupted in the secret. Re-export from the keychain.

**Workflow can't find Developer ID identity.** The `.p12` didn't import correctly. Try the export again, make sure you used the *exact* identity ("Developer ID Application", not "Apple Development" or "Apple Distribution").

**`spctl` says the DMG isn't notarized after a successful workflow run.** Notarization succeeded but stapling didn't. Re-run `xcrun stapler staple` against the DMG locally and re-upload.
