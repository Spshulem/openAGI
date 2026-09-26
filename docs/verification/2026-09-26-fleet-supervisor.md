# Fleet supervisor continuation verification

Preserved branch `spencer/supervisor-agent-mini-app` and PR #112. The continuation
uses Codex and keeps the existing observe-first prototype scope.

## Material findings addressed

The latest review was read through all available pages. Existing fixes on
`fc07296` cover isolated CLI state, cap recovery, model-limit choices, structured
question detection, complete BuildBot3 probes, upstream LB failures, failed
background attempt accounting, outreach closure, risky permission context, and
unknown mergeability. Their fleet regressions pass.

This continuation fixes:

- Undelivered answers disappearing for 24 hours: questions remain open when a
  route is absent or delivery fails. Partial cap recovery tracks successful
  recipients, allowing the remaining threads to be retried.
- Structured choices being replaced or truncated: supported original labels
  survive parsing, classification, policy, storage, and owner delivery. Free-text
  and multiple prompts direct the owner to the original thread.
- Shared login/disk questions losing stopped threads: each thread retains its
  own recovery question and delivery target.
- Exact pushed heads being marked unpushed because the branch tracks main.
- Old proposals sending after switching to Observe.
- Negative PR lookup refreshes starving later branches indefinitely.
- Stopped CI watchers waiting indefinitely when no checks exist on the head.
- Relay refusals containing DONE being misreported as successful delivery.

These affect ordinary recovery/readiness or the explicit observe boundary,
with impact at least 6/10 for affected users. Lost answers and discovery/wait
starvation do not self-repair on the next scan; opening the thread and retrying,
manual branch discovery, or manual agent continuation was previously required.
No additional speculative hardening or release work was added.

## Verification

- Node 22 focused changed-area tests: 124 passed.
- All fleet tests, including HTTP authentication/origin gates: 262 passed.
- Real read-only scan: 199 discovered, 94 in scope, 25.3 seconds, no source errors.
  BuildBot3 reachable; load balancer health HTTP 200. No agent or phone sends.
- Browser QA uses the current workspace server on 127.0.0.1:43311 with an
  isolated `.context/fleet-qa-data` directory, timer disabled, mode Observe.
- Hosted CI remains the full package/backend and G2 overlay verification gate.

The prototype does not mirror fleet questions onto physical G2 glasses or the
Distiller main. Delivery adapters are verified with isolated tests; this QA does
not send messages to real coding sessions. Desktop-held Codex writer locks and
non-live Conductor sessions still require opening the original thread.
