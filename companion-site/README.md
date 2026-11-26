# OpenAGI site preview

This is a static, reviewable preview of the OpenAGI website narrative and
information architecture. It is intentionally separate from the production
redirects at `openagi.sh`; it does not deploy or change the live site.

## Preview locally

From this directory:

```sh
python3 -m http.server 8789 --directory dist
```

Open <http://127.0.0.1:8789/>. The page is static and has no build step.

For the BuildBot3 preview used for acceptance, forward the remote server through the connected Mac with `ssh -N -L 8792:buildbot3:18791 spencer-mac`, then open <http://127.0.0.1:8792/> while that tunnel is running.

## Evidence and status

The `dist/assets/evidence/` screenshots are dated verification captures from
the repository's onboarding QA. Their captions distinguish shipped controls,
historical evidence, and fresh-install expectations. `research/factual-checks.md`
records the release, license, install, mobile, and competitor checks used by
the page.

This preview does not publish, merge, deploy, change the license, or imply that
the iOS/Android source builds have public store distribution.

## Pages

- `index.html` is the self-hosted runtime and Supervisor page. Its install
  cards link to [the latest GitHub release](https://github.com/Spshulem/openAGI/releases/latest),
  the all-platform download index, rather than to a pinned version.
- `onboarding.html` ("Get started") is the outcome-led handoff: Personal
  Assistant, Agent Supervisor, or Both. It labels the deterministic setup and
  the current Supervisor controls as shipped, and the unified opt-in
  discovery, notification handoff, and no-key help work as planned in
  `docs/plans/2026-11-21-onboarding-handoff.md`.
- `hardware.html`, `devices.html`, `device-guide.html`, `how-it-works.html`,
  `concept.html`, `prototype.html`, and `hardware/` are the hardware and DIY
  catalogue, with `ecosystem.html` (apps and integrations) and
  `technology.html`. They were recovered from the 2026-11-10 deployment at
  <https://openagi-hardware.vercel.app/> (see `research/recovered-deployment.json`)
  and keep their own stylesheets (`platform.css`, `overview.css`, `dot.css`,
  `hardware/build-notes.css`). Their navigation points back to the pages above.
- `setup.html` only forwards old links to the install section. `story.js` and
  `experience.js` are recovered scripts that no current page loads.

The `research/` deployment, manifest, browser-check, and screenshot records
describe the historical 2026-11-10 deployment (production deployment
`dpl_3iVoWbQ5tduUkcSsJvxFWCuksqyA`, 44 published files). They do not cover the
current pages; regenerate them only after the website owner reviews and
deploys a change. `docs/verification/2026-11-21-site-onboarding.md` records the
dated onboarding preview checks.
