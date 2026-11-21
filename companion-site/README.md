# OpenAGI website

Static website for the agent, Supervisor, apps, integrations, and optional hardware.

The original companion-site checkout was absent from the migrated workspace. The
public static files were recovered from https://openagi-hardware.vercel.app/ on
2026-11-10 before this revision. See research/recovered-deployment.json for the
complete recovery manifest. Additional baseline assets were recovered from the original Mac Git checkout
before publishing. No application-runtime files were changed.

Preview with: python3 -m http.server 8789 --directory dist

The software pages are GitHub-first: the hero, navigation, install section,
and footer link to the source repository, install docs, release page, and
platform downloads. `onboarding.html` is the reviewable outcome-led handoff;
it labels the deterministic setup and current Supervisor controls as shipped
and the unified opt-in discovery/no-key help work as planned.

The current public release evidence is v0.0.83: Mac DMG, Windows x64 ZIP, and
Linux x64/arm64 archives are on GitHub Releases. `openagi.sh/download` remains
a Mac convenience redirect. iOS and Android links intentionally point to
source/QA setup because no public store download is advertised.

This checkout is a static preview and PR input. Do not treat a local preview,
uploaded CI artifact, or Store submission as a production deployment.

Deploy only the contents of dist. Keep openagi.sh and its installer routing
separate.

The research manifest below records the historical 2026-11-10 deployment at
https://openagi-hardware.vercel.app/. It does not include this PR's new
onboarding page or GitHub-first copy; regenerate it only after the website
owner reviews and deploys the changes.

Production deployment: dpl_3iVoWbQ5tduUkcSsJvxFWCuksqyA. The staged build was
verified before promotion; all 44 published files match the release manifest.
Desktop and mobile browser checks passed on eight pages. See research/ for
the deployment record, file hashes, browser results, and screenshots.
