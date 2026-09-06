# Background routing and reminder repair

## Installed and verified

- 79 enabled prompt jobs recurring every 30 seconds were paused, not deleted.
  All 134 jobs remained in the store. The stopped service's original job store
  was copied into a private recovery directory and its SHA-256 verified before
  alteration. A manifest records the exact paused IDs. The owner environment
  and replaced source files were also backed up before installation.
- After restart, the main returned health 200. A live job read-back showed
  zero enabled matching runaway jobs and 79 paused jobs.
- Foreground provider read-back remained `gpt-6-astra`; canonical reasoning
  effort remained `medium`. The deployed router and canonical environment
  resolved chat to GPT-6 and all nine non-chat task profiles to `gpt-5.6-luna`.
  In particular, a cron-origin prompt delivered to `local` resolved to Luna.
- Budget read-back remained $20.0485 against $20. No spending reset, historical
  ledger rewrite, cap increase, provider call, or glasses re-pairing was performed.

## Regression coverage

162 focused tests passed across runtime, scheduling, model routing, overlap,
timeouts, manual runs, persisted markers, and budget preflight. The new four-test
reminder/model regression file passed twice. Coverage includes mutually exclusive
timing, invalid/short recurring intervals, duplicate reuse after restart, paused
schedule preservation, recursive scheduled-job rejection, and pausing failed
one-shots before work so subsequent ticks cannot keep retrying them.

The full repository suite was not run. `bb-remote ci plan` rejected this repository
because it is not a BuildBetter checkout, so no full laptop CI workaround was
started. Tests use isolated state and stubbed providers, not personal chats.

## Boundaries

The initial repair was installed on the main before publication. No G2 bundle was
built. Managed Codex/Claude CLI settings are separate and unchanged. Internal
deterministic polling jobs retain their intervals, and the new reminder safeguards
are not an independent background-spending quota. Earlier G2-client and supervisor
work is separate from the background/reminder and history-protection commit.

## Owner-authorized budget increase and readiness check

The owner subsequently authorized a $40 daily cap and publication of these fixes.
The canonical private environment was backed up and only its daily-limit field
changed; public defaults and historical usage were not changed. After restarting,
live read-back confirmed a $40 limit, 79 paused jobs, and zero matching enabled
30-second runaway prompt jobs.

A disposable foreground request through the live main's authenticated `/message`
endpoint returned its exact expected marker in 5.6 seconds using `gpt-6-astra`.
The subsequent budget read reported $20.1153 spent and $19.8847 remaining. This
verifies main-model readiness, not a physical glasses microphone/display test.
