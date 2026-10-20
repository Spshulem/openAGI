# Onboarding follow-up after PR #215

The design and packaging changes in #215 are merged. This follow-up addresses
late review findings without changing the green design or removing features.

## Fixes

- **Apple Intelligence provider menu (6/10):** selecting Automatic on a Mac
  without cloud credentials replaced its working on-device model with the
  deterministic fallback. Chat stayed unavailable across retries until the
  owner explicitly selected Apple Intelligence in setup. The menu now disables
  that transition while retaining the working model and other saved choices.
- **Conversation history (6/10):** Back or Forward to a URL naming conversation
  A could leave conversation B visible and selected. This affected ordinary
  navigation between deep-linked chats and persisted until a reload or manual
  selection, risking a follow-up in the wrong conversation. History navigation
  now loads the URL's session and request handoff after rendering the chat tab.
  A generation/location guard ignores superseded loads, including requests
  already in flight. Failed or deleted targets clear the previous conversation
  and request state before rendering a fresh chat.
- **Configured local first run (6/10):** an environment-configured local model
  in supported auth-disabled loopback mode was redirected from the dashboard
  to setup on every visit. Refresh could not repair it; completing the wizard
  or setting a token worked around it. A nonblank local model now counts as
  configured for first-run detection; blank values still require setup.

## Non-blocking dispositions

- **iPhone model availability detail (4/10):** the bridge's default availability
  label can say available while `onDevice` remains false on an unsupported or
  unready iPhone. Real inference verification still rejects an unavailable
  model, so setup cannot falsely succeed. This affects specific setup guidance;
  cloud setup remains available, and native model enablement can be retried.
  Forwarding more precise availability from the phone is deferred.
- **Local-model filtered tool schemas (4/10):** local inference currently shows
  the full registry instead of a turn's filtered schemas. Invocation-time
  allowlists and approval gates still enforce access. A bounded or read-only
  turn can waste model context or tool attempts on rejected calls; this does
  not establish an unauthorized action. Schema filtering is deferred.
- **Additional Automatic choices (4/10):** the conservative menu guard can also
  disable Automatic when Apple Intelligence is selected alongside a local model
  or ChatGPT sign-in. Those models remain selectable through setup; extending
  the quick menu's availability payload is deferred.

## Verification

Focused tests exercise actual HTTP first-run routing, the served model menu,
and the dashboard's history handler. Test servers use unique temporary data
directories and close in teardown. Final CI evidence is recorded in the PR.
The focused setup file passed twice, including the broader 45-test run covering
setup, conversation handoffs/history, local inference, and health/auth behavior.
After adding the history concurrency and failure guards, all 23 conversation
handoff/history tests passed twice, including delayed tab and session responses.
`git diff --check` passed.
No tagged release, public download, or installed-app update is part of this
follow-up.
