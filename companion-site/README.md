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
