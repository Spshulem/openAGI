# Model setup and navigation redesign

This updates PR #215. It preserves its installation and runtime packaging work.

The interface uses one navigation sidebar, restrained shared tokens, and a focused chat workspace. A three-step deterministic wizard connects and verifies a model before guided chat. Integrations, screen permissions, devices, and advanced configuration remain optional, separate setup paths.

## Acceptance

- [x] Connect an API model with only that provider's fields visible.
- [x] Connect an Ollama or compatible local server without a cloud key.
- [x] Offer Apple Intelligence with truthful availability on Mac and iOS.
- [x] Reject missing credentials, fallback echoes, and failed connections as setup success.
- [x] Verify the model before entering chat; preserve existing credentials on a rerun.
- [x] Exercise navigation, browser history, fresh guided chat, errors and narrow layouts.
- [x] Record focused tests, native compile evidence and screenshots. Exact-head CI is reported on PR #215.

Native model availability requires compatible hardware, OS, enabled Apple Intelligence and downloaded models. Browser fixtures cannot establish hardware acceptance.

## Verification evidence

- Focused regression set: 82 passed. After the final draft-preservation edit,
  the affected chat, setup and security tests passed (38), plus the guide,
  local-provider and context-trimming tests (9).
- Shared Apple model sources: `xcrun swiftc -typecheck` passed for macOS.
- Real Apple Foundation Models inference: a disposable native helper built
  from the shared bridge connected to the isolated runtime. The browser setup
  page verified `apple-foundation-models` successfully. The installed app was
  not changed. This does not establish packaged Mac or physical iPhone acceptance.
- Local-server UI verification used a disposable Chat Completions fixture at
  loopback port 43322. No cloud key, paid call, account connection, screen
  capture, computer action, or phone pairing was used.
- Browser walkthrough: choose/configure/verify/start, missing key, unreachable
  server and retry, guided draft/send, Back/Forward, draft retention across tabs,
  narrow navigation, Escape dismissal, no horizontal overflow and dark appearance.
- Native Mac and iOS compilation/tests, full runtime regression and packaged
  Windows/Linux smoke checks run on the final PR head in GitHub Actions.
- CI follow-up: updated legacy navigation assertions, the model-setup handoff
  smoke check, and the iOS model greeting expectation for availability reporting.
  All 55 affected JavaScript tests and disposable source startup passed locally.

| Surface | Evidence | Verified state |
| --- | --- | --- |
| Model setup | [Choose](onboarding-redesign/model-choice.png) | Only model selection before credentials |
| Getting started | [Guides](onboarding-redesign/guides.png) | One recommended first step, optional guides and collapsed details |
| Chat | [Guided draft](onboarding-redesign/guided-chat.png) | One selected guide, editable draft, no duplicate welcome choices |
| Narrow workspace | [Navigation](onboarding-redesign/narrow-navigation.png) | Sidebar menu at 390px; selection and Escape dismiss it |

The local standalone walkthrough and additional error/native-model screenshots
are in the Codex artifact `onboarding-redesign/walkthrough.html`.

## Green refinement and functionality parity

- Restored green accents in light and dark appearance and removed the upper-left
  branding from the workspace and setup page. Refreshed the screenshots above.
- Compared navigation with current main: all 21 original destinations remain,
  plus Get started. Fleet and glasses links, advanced settings, and the original
  quick switch between saved providers remain accessible. The quick switch is
  now in a compact footer menu.
- This PR includes functional setup improvements as well as visual changes:
  candidate models are verified before their settings are saved or activated.
  A failed change leaves the working model, keys, and background work intact.
- Native/ChatGPT first-run setup bootstraps only dashboard authentication. Its
  access token is available to copy before that step, including after a failed
  model connection. Existing owner tokens remain unchanged.
- Local vision models receive screenshots as multimodal image content using
  the existing provider-neutral image parser, with bounded context accounting.
  Plain-text local models still require a compatible vision model for screen use.
- The onboarding handoff requests a fresh chat; the compact on-device prompt
  includes stepwise onboarding and credential/approval guidance. Installation
  instructions now use the labels displayed by the new wizard.
- Release signing and publishing now depend on the native test job. No release
  was created by this verification.
- Current main's provider-key checks, regional diagnostics, spend/context caps,
  and Fleet approval/storage fixes were retained during conflict resolution.
- Verification: 49 focused regressions passed, followed by the six local-model
  tests after image context accounting changed. Source startup smoke passed.
  Browser QA verified green accents, no branding, model verification then save,
  the chat handoff, desktop navigation and the menu at 390px without overflow.

The earlier secondary portable-document links and broader packaging-trigger
coverage remain documented 4/10 deferrals; neither was claimed fixed by this PR.

## Final local-model review fixes

- Buffer screenshot messages until every result in a tool-call batch has been
  appended. This keeps multi-tool screen requests valid for Chat Completions
  servers, including batches with more than one screenshot.
- Automatic provider selection retains a configured local model on a desktop
  without cloud credentials. Cloud precedence and the phone's native fallback
  remain unchanged.
- All 13 affected local-provider and offline-fallback regressions passed. The
  context-trimming checks and `git diff --check` also passed. Final-head hosted
  verification is reported on PR #215 before merge.
