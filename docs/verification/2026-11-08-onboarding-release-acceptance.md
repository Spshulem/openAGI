# OpenAGI v0.0.66 onboarding acceptance

The redesign and setup improvements are merged in PRs #215 and #219. This
report records acceptance of released v0.0.66 and separates runtime checks
from interactive device coverage. No application code or release was changed
by this QA pass.

## Results

| Surface | Result | Evidence and limits |
| --- | --- | --- |
| Mac packaged web onboarding | Passed | Actual DMG's bundled runtime, disposable state, first-run redirect, provider choices, missing-key/model validation, retry/Back navigation, no configuration saved after failure, and no horizontal overflow at 390px. |
| Local model | Passed | Real Ollama Qwen3 0.6b: verify, ready screen, chat handoff, guided first response, follow-up, and reopening saved conversation after refresh. |
| Apple Intelligence | Passed on installed v0.0.64 | Native candidate verification returned HTTP 200, `ok: true`, model `apple-foundation-models`, reply `Hello.`. Saved configuration remained byte-for-byte unchanged. This is not fresh v0.0.66 native inference coverage. |
| Fresh native Mac v0.0.66 | Startup passed | Clean arm64 Mac on macOS 15.7.9: no prior app, data directory, or port listener. Copied notarized app launched its bundled daemon and served the first-run wizard. |
| Linux x64 download | Startup passed | Published archive's launcher executed bundled Node on Linux; health returned 200 and a fresh visit redirected to the model wizard. |
| Windows x64 runtime | Release CI passed | Exact v0.0.66 packaging job executed bundled node.exe, imported modules, started the runtime, and checked health, authenticated setup, and dashboard JavaScript before publication. |
| Windows desktop experience | Blocked | Existing Windows 11 VM cannot be reached because Parallels Service fails to initialize. Normal app launch also timed out. No connected Windows host was available. |
| Physical iPhone | Launch only | Older build 2116 launched. Mirroring setup subsequently completed with notification forwarding declined, but connection to the phone timed out. UI acceptance remains blocked on a successful Mirroring connection. |

## Screenshots

- [Verified local model](onboarding-2026-11-08/ollama-connected.png)
- [Real local-model conversation](onboarding-2026-11-08/ollama-chat.png)
- [Narrow connection/error layout](onboarding-2026-11-08/connect-mobile.png)

## Fresh Mac verification

The published DMG matched SHA-256
`dc7ba8cf2cbeb724b555efcc0fb92aac50362c2863ef70471c057f1f8fc95230`.
`codesign --verify --deep --strict` succeeded and Gatekeeper assessment returned
`accepted`, `source=Notarized Developer ID`. No security bypass was used.

The unmodified native app was copied into a temporary installation directory
and launched through LaunchServices. Its Info.plist reported 0.0.66. Process
parentage showed the native application spawning the release's bundled Node
and hosted-server entry point. Health reported `ok: true`, `firstRun: true`;
GET `/` redirected to `/setup`, returned 200, and contained the model wizard.
No saved provider configuration existed. The app and daemon remained running
on a subsequent check. The macOS 15 host reported its native model disconnected.

This verifies fresh installation/startup, not Finder drag-and-drop into
/Applications, native permission dialogs, or an interactive graphical
walkthrough on that remote Mac. Existing personal installations were preserved.

## Windows release evidence

[Release run 42456350328](https://github.com/Spshulem/openAGI/actions/runs/42456350328)
ran at tag commit `1918f822a0f2fefa6e9a55438e5f0bc98f1682cd`.
[Windows job 128657222148](https://github.com/Spshulem/openAGI/actions/runs/42456350328/job/128657222148)
succeeded on Windows Server 2025 x64, with eight tests passed and zero failed.
At 06:56:36 UTC its log recorded:

> Runtime boot, health, authenticated setup, and guided dashboard passed on win32/x64

The publish job uploaded the Windows ZIP at 06:57:31 UTC. Inspection of
`scripts/smoke-runtime.mjs` at that tag confirms this runs bundled `node.exe`
with `bin/openagi.js serve` using disposable state, then requests and validates
the pages. It does not run `Start-OpenAGI.cmd`, operate a browser, or connect a
model. These are existing release-time results, not a new Windows QA run.

To complete interactive Windows acceptance, restore a working Parallels
service or provide a connected Windows host, extract the published ZIP, launch
`Start-OpenAGI.cmd`, and complete model setup/chat in the browser. The service
reported `Unable to connect to Parallels Service` and failed unattended
initialization; no host reboot or privileged repair was attempted.

## Local-model limits and cleanup

A strict exact-wording check failed because the small model added words to its
answer; actual inference, message delivery, and persistence passed. An immediate
scripted draft edit raced the asynchronous guided-draft handoff, sending the
original guide text. A separately entered follow-up succeeded. Neither exact
instruction adherence nor every draft race is claimed as passed.

LM Studio, interactive Windows, remote native permission dialogs, and physical
iPhone UI remain unverified. Linux arm64 has release CI coverage but no separate
manual execution in this QA pass. No app-usage telemetry was implemented.

Task-owned local and remote runtimes, model downloads, mounts, and temporary
installations were removed. The clean Mac's newly created data directory was
removed after stopping its app and daemon; its port was confirmed clear.
