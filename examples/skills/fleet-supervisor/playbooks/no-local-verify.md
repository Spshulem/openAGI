---
id: no-local-verify
cooldown_min: 30
max_attempts: 2
ask: ""
---
Stop. Don't verify locally. You should be able to do this on BuildBot3. You shouldn't need to use any local resources. Run bb-quick on BuildBot3 while the PR is half-built, and one full run (bb-verify --full) when it is finished: that run is the merge gate.
