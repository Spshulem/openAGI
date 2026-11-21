# Website and onboarding handoff verification

**Date:** 2026-11-21
**Branch:** `codex/openagi-site-github-quickstart`
**Scope:** static website, GitHub-first install copy, and tracked Mac/iOS
onboarding plan. No production deployment, release, merge, Store submission,
or native app source change was made.

## Fresh website preview

The preview was served from the branch with:

```sh
python3 -m http.server 8789 --directory companion-site/dist
```

Playwright captured the home page, install page, new onboarding page, and the
onboarding page at a 390px viewport. All returned HTTP 200, had no browser
console/page errors, and had no horizontal overflow.

| Capture | What it shows |
| --- | --- |
| [Home](2026-11-21-site-onboarding/home.png) | GitHub source link in the hero/nav, Supervisor explanation, and the install shell command |
| [Install](2026-11-21-site-onboarding/setup.png) | Mac, portable, source, release/docs links and the Personal Assistant / Supervisor / Both handoff |
| [Onboarding desktop](2026-11-21-site-onboarding/onboarding.png) | Outcome-led paths, shipped/planned labels, local/offline boundaries, and Mac/iPhone distinctions |
| [Onboarding mobile](2026-11-21-site-onboarding/onboarding-mobile.png) | The same path at 390px without horizontal overflow |
| [Machine results](2026-11-21-site-onboarding/results.json) | URL, status, heading, viewport, overflow and console-error evidence |

These are fresh static-preview screenshots, not screenshots of a deployed
`openagi.sh` site. The PR is reviewable before the website owner deploys it.

## Current runtime walkthrough

I also ran the current `main` runtime from this branch in a disposable data
directory on `127.0.0.1:43311` and captured the actual served UI. This is
current local evidence, not a public deployment or a provider/device test:

| Capture | What it verifies |
| --- | --- |
| [Setup wizard](2026-11-21-site-onboarding/app-setup-wizard-current.png) | Current three-step model wizard offers Anthropic, OpenAI, local model, Apple Intelligence, and ChatGPT plan; it states that keys stay on the host and connected accounts/screen access are optional |
| [First chat / Get started](2026-11-21-site-onboarding/app-setup-current.png) | Current dashboard exposes Chat, Get started, Supervisor, Saved preferences, Tasks, Inbox, and Approvals, with three concrete first-result starters |
| [Supervisor](2026-11-21-site-onboarding/app-supervisor-current.png) | Current empty state separates Managed sessions from Other coding conversations, defaults to Observe, and exposes Coding setup / Scan now |
| [Runtime metadata](2026-11-21-site-onboarding/app-setup-wizard-current.json) | HTTP status, route, title, heading, viewport, and zero console/page errors |

The app screenshots show what is shipped today. They do not prove a real cloud
reply, local-model inference, physical Apple Intelligence availability,
installed-app prescan, pairing, notifications, or Computer Use. Those checks
remain in the tracked plan rather than being implied by the screenshots.

## Public download evidence

`gh release view v0.0.83` on 2026-11-21 returned public assets for the Mac DMG,
Windows x64, Linux x64, and Linux arm64 plus checksums for portable archives.
`curl -IL https://openagi.sh/download` returned a redirect to the Mac DMG;
`curl -IL https://openagi.sh/install` returned the public shell installer.
The all-platform release page remains the canonical index.

The website and README therefore distinguish:

- **Publicly downloadable:** GitHub v0.0.83 release assets.
- **Uploaded / CI evidence:** workflow artifacts and Store submissions; these
  are not advertised as public installs.
- **Source/QA only:** iOS and Android companion builds.
- **Planned:** unified opt-in discovery, test-notification handoff, and the
  bundled no-key setup/help skill.

## Current app evidence and limits

The current branch's onboarding contract tests passed:

```text
node --test test/get-started.test.js test/runtime-downloads.test.js \
  test/runtime-smoke.test.js test/atomic-write.test.js
23 passed, 0 failed
```

The tests verify editable guided starters, verified-progress routing, portable
packaging, Windows launcher relocation, dependency links, and runtime startup.
They do not prove a physical Mac/iPhone walkthrough or a real provider reply.

The most complete existing interactive app walkthrough is the historical
[2026-11-11 new-user onboarding report](2026-11-11-new-user-onboarding.md),
which tested v0.0.70 on a disposable Linux backend and includes 27 screenshots.
It is retained as historical evidence and clearly says that native Mac,
physical iPhone, pairing, notifications, and local/Apple model coverage were
not exercised. The newer v0.0.66 release-acceptance report records Windows
release-run coverage and a fresh native Mac startup, but it is not a current
physical-device acceptance pass.

Physical iPhone UI testing remains dependent on Mirroring/device access. The
Mac/iOS implementation plan records the exact standalone, two-way pairing,
no-key/offline, permission-denial, and notification checks still required.
