---
id: merge-ready
cooldown_min: 12
max_attempts: 3
ask: "#{pr} stuck. {blocker}. Help?"
---
Ready to merge? If not, get it ready. Left on #{pr} at {head}: {blockers}.
Resolve PR comments ≥6/10 severity (reply + resolve), merge main if behind or conflicting, bb-quick on BuildBot3 (not locally), push, hosted CI green on the exact head, QA on the BuildBot3 preview with screenshots when UI changed. Don't ask permission for in-scope steps.
Reply: PR link + head SHA / CI / open ≥6/10 / blocked on.
