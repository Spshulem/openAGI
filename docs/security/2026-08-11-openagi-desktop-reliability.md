# Desktop reliability security review — 2026-08-11

Scope: the desktop review queue and cleanup flow, streamed chat, updater and
daemon controls, service-node discovery, MCP OAuth lifecycle, and the first
Computer Use readiness increment.

## Result

No open Critical or High severity finding remains in the reviewed change.
The review covered authentication and path containment, secret handling,
provider-stream resource bounds, untrusted model context, browser rendering,
macOS permission migration, and process lifecycle races.

## Findings closed before review sign-off

- Public service-node status exposes only an origin. Credential-bearing paths,
  userinfo, queries, and fragments remain private to the health probe and are
  scrubbed from errors. Health responses are cancelled without buffering an
  untrusted body.
- OpenAI and Anthropic streams retain absolute and idle deadlines, cap frame,
  buffer, and total response sizes, reject sparse block indexes, and stop on a
  terminal event instead of waiting forever for EOF.
- Runtime task, draft, clarification, and suggestion content is explicitly
  treated as untrusted data. It cannot grant tool intent. Provider failures are
  classified and redacted before durable storage or global event broadcast.
- Task-source and rendered Markdown links accept only HTTP(S), and new dynamic
  dashboard fields continue through the existing escaping and CSP boundary.
- OAuth token deletion validates a single safe server-name segment, resolves it
  inside the configured data directory, disconnects the client first, and does
  not disclose token material. Catalog migration applies only to exact built-in
  ids at exact retired URLs; custom registrations are untouched.
- Computer Use remains opt-in and confirmation-gated. It requires an approved
  session, inspects before acting, exposes no node credential in readiness
  status, and reports observation-only when no reachable input executor exists.
- Screen Recording permission migration is signing-identity scoped, preventing
  local and release builds from consuming each other's migration marker.
- Delayed daemon restart callbacks verify the exiting process identity before
  touching a newer child.

## Dependency and residual notes

`npm audit --omit=dev` cannot run because this repository has no npm lockfile
(`ENOLOCK`). A lockfile was not generated as an unrelated public-repository
mutation. The macOS package is pinned by `mac/Package.resolved` and compiled in
the signed verification build.

Two low-severity usability items remain outside this release gate: a synchronous
daemon-port lookup can delay opening its menu, and some icon-only controls need
explicit VoiceOver labels. Native local click/type execution is not claimed by
this increment; without a reachable control node the UI and agent both state
that input is unavailable.
